using System.Net;
using System.Security.Cryptography;
using Jellyfin.Data.Events;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources;
using MediaBrowser.Controller.Library;
using Moq;
using SkiaSharp;

namespace JE.Tests;

// Poster collage of placeholder-only lists: the rule matrix, poster order, the render geometry and the service against
// an in-memory list host, an in-memory image host and a fake TMDB image server (no network).
[Collection("Plugin singleton")]
public partial class ListPlaceholdersCollageTests
{
    private static readonly SKColor[] Colors =
    {
        new(220, 30, 30), new(30, 200, 30), new(30, 60, 220), new(230, 220, 30), new(200, 30, 200), new(30, 210, 210),
    };

    /// <summary>The list image state of one fake list.</summary>
    private sealed class FakeImage
    {
        public string Path { get; set; } = string.Empty;
        public bool Generated { get; set; }
        public byte[] Bytes { get; set; } = Array.Empty<byte>();
    }

    /// <summary>In-memory <see cref="IListImageHost"/>: JE saves land in a "metadata" path, like Jellyfin's internal folder.</summary>
    private sealed class FakeImageHost(FakeListHost lists) : IListImageHost
    {
        public Dictionary<Guid, FakeImage> Images { get; } = new();
        public List<string> Calls { get; } = new();

        public ListImageState GetPrimaryImage(Guid listId)
        {
            if (!lists.Lists.ContainsKey(listId))
            {
                return ListImageState.Missing;
            }

            return Images.TryGetValue(listId, out var image)
                ? new ListImageState(true, image.Path, true, image.Generated)
                : new ListImageState(true, null, false, false);
        }

        public string? HashFile(string path)
        {
            var image = Images.Values.FirstOrDefault(i => i.Path == path);
            return image == null ? null : Convert.ToHexString(SHA256.HashData(image.Bytes)).ToLowerInvariant();
        }

        public (int Width, int Height)? GetPngSize(string path)
        {
            var image = Images.Values.FirstOrDefault(i => i.Path == path);
            return image == null ? null : ListImageHeader.PngSize(image.Bytes);
        }

        /// <summary>Runs right after JE's image is saved (Jellyfin raises ItemUpdated from that write).</summary>
        public Action<Guid>? AfterWrite { get; set; }

        /// <summary>Thrown by the next image write (a failing write), then cleared.</summary>
        public Exception? WriteException { get; set; }

        /// <summary>Thrown by the next image write after the image was saved (the item update failed or was cancelled), then cleared.</summary>
        public Exception? ExceptionAfterWrite { get; set; }

        /// <summary>Awaited at the start of every image delete (holds a removal in flight).</summary>
        public Func<Task>? BeforeDelete { get; set; }

        /// <summary>Runs right before the image is compared and written (simulates an upload landing in that window).</summary>
        public Action<Guid>? BeforeWrite { get; set; }

        private bool IsStill(Guid listId, string? expectedPath, string? expectedSha256)
        {
            BeforeWrite?.Invoke(listId);
            if (!Images.TryGetValue(listId, out var current))
            {
                return expectedPath == null;
            }

            return current.Path == expectedPath
                && (expectedSha256 == null || Convert.ToHexString(SHA256.HashData(current.Bytes)).ToLowerInvariant() == expectedSha256);
        }

        public Task<string?> SetPrimaryImageAsync(Guid listId, byte[] jpeg, string? expectedPath, string? expectedSha256, CancellationToken cancellationToken)
        {
            Calls.Add("set:" + listId.ToString("N"));
            if (WriteException is { } error)
            {
                WriteException = null;
                throw error;
            }

            if (!lists.Lists.ContainsKey(listId) || !IsStill(listId, expectedPath, expectedSha256))
            {
                return Task.FromResult<string?>(null);
            }

            var path = "/metadata/" + listId.ToString("N") + "/poster.jpg";
            Images[listId] = new FakeImage { Path = path, Generated = true, Bytes = jpeg };
            AfterWrite?.Invoke(listId);
            if (ExceptionAfterWrite is { } late)
            {
                ExceptionAfterWrite = null;
                throw late;
            }

            return Task.FromResult<string?>(path);
        }

        public async Task<bool> DeletePrimaryImageAsync(Guid listId, string expectedPath, string? expectedSha256)
        {
            Calls.Add("delete:" + listId.ToString("N"));
            if (BeforeDelete is { } before)
            {
                await before();
            }

            return IsStill(listId, expectedPath, expectedSha256) && Images.Remove(listId);
        }

        public void QueueImageRefresh(Guid listId) => Calls.Add("refresh:" + listId.ToString("N"));

        public void SetUserImage(Guid listId) =>
            Images[listId] = new FakeImage { Path = "/data/playlists/" + listId.ToString("N") + "/folder.jpg", Generated = false, Bytes = new byte[] { 1, 2, 3 } };

        /// <summary>The collage Jellyfin builds for a playlist with items: a 600x600 PNG in the internal metadata folder.</summary>
        public byte[] SetJellyfinCollage(Guid listId, int content = 4) =>
            SetMetadataImage(listId, "poster.png", Poster(Colors[content % Colors.Length], 600, 600));

        /// <summary>An image in the list's internal metadata folder (where Jellyfin saves an upload it can't save next to the list).</summary>
        public byte[] SetMetadataImage(Guid listId, string fileName, byte[] bytes)
        {
            Images[listId] = new FakeImage { Path = "/metadata/" + listId.ToString("N") + "/" + fileName, Generated = true, Bytes = bytes };
            return bytes;
        }
    }

    private sealed class Fixture : IDisposable
    {
        /// <summary>The list placeholder services (incl. the real parental filter) behind a synthetic Seerr.</summary>
        public ListPlaceholdersHarness H { get; } = new(seerr: true);
        public ApiPluginFixture Plugin => H.Plugin;
        public FakeListHost Host => H.Host;

        /// <summary>Every Jellyfin user (what <c>IUserManager</c> enumerates).</summary>
        public List<User> AllUsers { get; } = new();

        /// <summary>Holds poster downloads whose name starts with "slow" until set.</summary>
        public TaskCompletionSource SlowGate { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource SlowRequested { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public FakeImageHost Images { get; }
        public Mock<ILibraryManager> Library { get; } = new();
        public IntegrationTransport Tmdb { get; }
        public List<string> PosterRequests { get; } = new();

        /// <summary>Poster names (e.g. "p1") the fake TMDB answers with 502 for now.</summary>
        public HashSet<string> Down { get; } = new();

        /// <summary>
        /// The poster Seerr has per movie id (what the synthetic Seerr's movie details carry, with the certification of
        /// <see cref="ListPlaceholdersHarness.MovieCertifications"/>); <see cref="Seed"/> fills it.
        /// </summary>
        public Dictionary<int, string> ServerPosters { get; } = new();
        public ListPlaceholderStore Store => H.Store;
        public ListPlaceholderCollageService Service { get; }
        public FakeListHost.FakeList Playlist { get; }
        public FakeListHost.FakeList Collection { get; }

        public Fixture()
        {
            Plugin.Plugin.Configuration.ListPlaceholdersEnabled = true;
            Plugin.Plugin.Configuration.ListPlaceholdersPosterCollage = true;
            Images = new FakeImageHost(Host);
            var seerr = H.Reply;
            H.Reply = request =>
            {
                // Movie details with a certification carry the movie's poster too (one Seerr endpoint serves both).
                var path = request.RequestUri!.AbsolutePath;
                if (path.StartsWith("/api/v1/movie/", StringComparison.Ordinal)
                    && int.TryParse(path["/api/v1/movie/".Length..], out var id)
                    && H.MovieCertifications.TryGetValue(id, out var cert)
                    && ServerPosters.TryGetValue(id, out var poster))
                {
                    return IntegrationTransport.Response("{\"id\":" + id + ",\"posterPath\":\"" + poster + "\",\"releases\":{\"results\":[{\"iso_3166_1\":\"US\",\"release_dates\":[{\"certification\":\"" + cert + "\",\"type\":3}]}]}}");
                }

                return seerr(request);
            };
#if NET9_0
            H.Users.SetupGet(u => u.Users).Returns(() => AllUsers);
#else
            H.Users.Setup(u => u.GetUsers()).Returns(() => AllUsers);
#endif
            Tmdb = new IntegrationTransport(async (request, _) =>
            {
                var path = request.RequestUri!.AbsolutePath;
                lock (PosterRequests)
                {
                    PosterRequests.Add(path);
                }

                Assert.Equal("image.tmdb.org", request.RequestUri.Host);
                var name = path["/t/p/w342/".Length..^4];
                if (name.StartsWith("missing", StringComparison.Ordinal))
                {
                    return new HttpResponseMessage(HttpStatusCode.NotFound);
                }

                bool down;
                lock (Down)
                {
                    down = Down.Contains(name);
                }

                if (down || name.StartsWith("down", StringComparison.Ordinal))
                {
                    return new HttpResponseMessage(HttpStatusCode.BadGateway);
                }

                byte[] body;
                if (name.StartsWith("corrupt", StringComparison.Ordinal))
                {
                    body = Truncated(Poster(Colors[0]));
                }
                else if (name.StartsWith("slow", StringComparison.Ordinal))
                {
                    SlowRequested.TrySetResult();
                    await SlowGate.Task;
                    body = Poster(Colors[5]);
                }
                else
                {
                    var index = int.Parse(name[1..], System.Globalization.CultureInfo.InvariantCulture);
                    body = Poster(Colors[index % Colors.Length]);
                }

                var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(body) };
                response.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");
                return response;
            });
            Service = NewService(Images);
            var owner = FakeListHost.MakeUser("owner");
            Playlist = Host.AddPlaylist(owner);
            Collection = Host.AddCollection();
        }

        public ListPlaceholderCollageService NewService(IListImageHost images) =>
            new(Store, Host, images, Tmdb, Library.Object, H.Access, H.Users.Object, H.Metadata, Plugin.Core.Logger)
            {
                Debounce = TimeSpan.FromMilliseconds(50),
                MaxDelay = TimeSpan.FromMilliseconds(500),
                StartupDelay = TimeSpan.FromHours(1),
            };

        /// <summary>A user with parental controls (max score 10 = PG) that IUserManager lists.</summary>
        public User Kid()
        {
            var kid = H.NewUser("kid", maxRating: 10);
            AllUsers.Add(kid);
            return kid;
        }

        public static string Id(FakeListHost.FakeList list) => list.Info.Id.ToString("N");

        /// <summary>Saves placeholders (poster "/p{n}.jpg" per entry; null = no poster) in this order.</summary>
        public List<Placeholder> Seed(FakeListHost.FakeList list, params string?[] posters)
        {
            var doc = Store.LoadForUpdate(Id(list), list.Info.Kind);
            var added = new List<Placeholder>();
            for (var i = 0; i < posters.Length; i++)
            {
                var placeholder = new Placeholder
                {
                    Id = Guid.NewGuid().ToString("N"),
                    Kind = PlaceholderKinds.Movie,
                    MediaType = "movie",
                    TmdbId = 1000 + doc.Items.Count,
                    Title = "Movie " + i,
                    PosterPath = posters[i],
                    ReleaseDate = "2000-01-" + (10 + doc.Items.Count).ToString(System.Globalization.CultureInfo.InvariantCulture),
                };
                doc.Items.Add(placeholder);
                if (posters[i] != null)
                {
                    ServerPosters[placeholder.TmdbId.Value] = posters[i]!;
                }

                if (list.Info.Kind == ListKinds.Playlist)
                {
                    doc.Order.Add(ListPlaceholderOrder.PlaceholderToken(placeholder.Id));
                }

                added.Add(placeholder);
            }

            Store.Save(doc);
            return added;
        }

        public Task<CollageDecision> Evaluate(FakeListHost.FakeList list) => Service.EvaluateAsync(Id(list), CancellationToken.None);

        public SKBitmap Image(FakeListHost.FakeList list) => SKBitmap.Decode(Images.Images[list.Info.Id].Bytes);

        public void Dispose()
        {
            SlowGate.TrySetResult();
            Service.Dispose();
            Tmdb.Dispose();
            H.Dispose();
        }
    }

    private static byte[] Truncated(byte[] png) => png[..(png.Length / 2)];

    private static byte[] Poster(SKColor color, int width = 342, int height = 513)
    {
        using var bitmap = new SKBitmap(width, height);
        bitmap.Erase(color);
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    private static void AssertColor(SKColor expected, SKColor actual)
    {
        // JPEG: allow some drift.
        Assert.True(Math.Abs(expected.Red - actual.Red) < 40 && Math.Abs(expected.Green - actual.Green) < 40 && Math.Abs(expected.Blue - actual.Blue) < 40, $"expected {expected}, got {actual}");
    }

    // ---- rules ----------------------------------------------------------------------------------------------------

    [Theory]
    // enabled, want, hasImage, ours, jellyfinCollage (seen while the list had items), unchanged, marker -> decision
    [InlineData(true, true, false, false, false, false, false, CollageDecision.Set)]      // no image yet
    [InlineData(true, true, true, true, true, true, true, CollageDecision.None)]          // ours, same posters
    [InlineData(true, true, true, true, true, false, true, CollageDecision.Set)]          // ours, posters changed
    [InlineData(true, true, true, false, true, false, false, CollageDecision.Set)]        // Jellyfin's stale collage
    [InlineData(true, true, true, false, false, false, false, CollageDecision.None)]      // someone's image (wherever it is saved)
    [InlineData(true, true, true, false, false, false, true, CollageDecision.Forget)]     // someone replaced ours
    [InlineData(true, false, true, true, true, true, true, CollageDecision.Remove)]       // real item arrived
    [InlineData(true, false, true, false, true, false, false, CollageDecision.None)]      // Jellyfin's own collage
    [InlineData(true, false, true, false, true, false, true, CollageDecision.Forget)]     // Jellyfin replaced ours
    [InlineData(true, false, false, false, false, false, false, CollageDecision.None)]    // nothing to show
    [InlineData(false, true, false, false, false, false, false, CollageDecision.None)]    // off: never sets
    [InlineData(false, true, true, false, true, false, false, CollageDecision.None)]      // off: leaves Jellyfin's
    [InlineData(false, true, true, true, true, true, true, CollageDecision.Remove)]       // off: takes back its own
    [InlineData(false, false, true, false, false, false, true, CollageDecision.Forget)]
    public void TheRulesOnlyEverTouchJesOwnOrJellyfinsGeneratedImage(bool enabled, bool want, bool hasImage, bool ours, bool jellyfinCollage, bool unchanged, bool marker, CollageDecision expected)
    {
        Assert.Equal(expected, CollageRules.Decide(enabled, want, hasImage, ours, jellyfinCollage, unchanged, marker));
    }

    [Fact]
    public void PosterCandidatesFollowPlaylistOrderAndCollectionReleaseOrder()
    {
        Placeholder Ph(string id, string? poster, string? date) => new() { Id = id, Title = id, PosterPath = poster, ReleaseDate = date };
        var playlist = new ListDoc
        {
            ListKind = ListKinds.Playlist,
            Items = { Ph("a", "/p0.jpg", "2003-01-01"), Ph("b", "/p1.jpg", "2001-01-01"), Ph("c", "/p0.jpg", null), Ph("d", "../etc.jpg", null), Ph("e", null, null), Ph("f", "/p2.jpg", null), Ph("g", "/p3.jpg", null) },
            Order = { "p:b", "e:" + Guid.NewGuid().ToString("N") + ":0", "p:a", "p:c", "p:d", "p:e" },
        };

        // Order first (b, a, then duplicate/invalid/no poster skipped), then placeholders the order doesn't know yet.
        Assert.Equal(new[] { "/p1.jpg", "/p0.jpg", "/p2.jpg", "/p3.jpg" }, ListPlaceholderCollageService.PosterCandidates(playlist, ListKinds.Playlist));
        Assert.Equal(new[] { "/p1.jpg", "/p2.jpg" }, ListPlaceholderCollageService.PosterCandidates(playlist, ListKinds.Playlist, new[] { "/p0.jpg" }, 2));

        // Collections: release-date order (undated last).
        Assert.Equal(new[] { "/p1.jpg", "/p0.jpg", "/p2.jpg", "/p3.jpg" }, ListPlaceholderCollageService.PosterCandidates(playlist, ListKinds.Collection));
    }

    // ---- rendering ------------------------------------------------------------------------------------------------

    [Theory]
    [InlineData(1, true)]
    [InlineData(2, true)]
    [InlineData(3, true)]
    [InlineData(4, true)]
    [InlineData(1, false)]
    [InlineData(2, false)]
    [InlineData(3, false)]
    [InlineData(4, false)]
    public void TheCollageHasJellyfinsListImageShapeAndOnePosterPerCell(int count, bool square)
    {
        var posters = Enumerable.Range(0, count).Select(i => Poster(Colors[i])).ToList();
        var jpeg = ListPlaceholderCollageRenderer.Render(posters, square);
        Assert.NotNull(jpeg);
        using var bitmap = SKBitmap.Decode(jpeg);
        var (width, height) = square ? (600, 600) : (400, 600);
        Assert.Equal(width, bitmap.Width);
        Assert.Equal(height, bitmap.Height);

        var cells = ListPlaceholderCollageRenderer.Layout(count, width, height);
        Assert.Equal(count, cells.Count);
        // The cells tile the canvas exactly: no gaps, no overlaps.
        Assert.Equal(width * height, cells.Sum(c => (long)c.Width * c.Height));
        for (var i = 0; i < cells.Count; i++)
        {
            for (var j = i + 1; j < cells.Count; j++)
            {
                var a = cells[i];
                var b = cells[j];
                var overlap = Math.Max(0, Math.Min(a.Right, b.Right) - Math.Max(a.Left, b.Left)) * Math.Max(0, Math.Min(a.Bottom, b.Bottom) - Math.Max(a.Top, b.Top));
                Assert.True(overlap == 0, $"cells {i} and {j} overlap");
            }
        }

        if (count == 1 && square)
        {
            // The whole poster, centred (400x600) on a darkened blurred copy of itself.
            AssertColor(Colors[0], bitmap.GetPixel(300, 300));
            var edge = bitmap.GetPixel(10, 300);
            Assert.True(edge.Red < Colors[0].Red - 40, $"the backdrop is darkened ({edge})");
            return;
        }

        for (var i = 0; i < count; i++)
        {
            AssertColor(Colors[i], bitmap.GetPixel(cells[i].MidX, cells[i].MidY));
        }
    }

    [Fact]
    public void RenderingSkipsUndecodablePostersAndUsesAtMostFour()
    {
        Assert.Null(ListPlaceholderCollageRenderer.Render(new[] { new byte[] { 1, 2, 3 } }, true));
        var jpeg = ListPlaceholderCollageRenderer.Render(new[] { new byte[] { 9 }, Poster(Colors[0]), Poster(Colors[1]), Poster(Colors[2]), Poster(Colors[3]), Poster(Colors[4]) }, false);
        using var bitmap = SKBitmap.Decode(jpeg);
        AssertColor(Colors[0], bitmap.GetPixel(100, 150));
        AssertColor(Colors[3], bitmap.GetPixel(300, 450));
    }

    // ---- service --------------------------------------------------------------------------------------------------

    [Fact]
    public async Task APlaceholderOnlyPlaylistGetsASquareCollageOfItsFirstFourPostersInOrder()
    {
        using var f = new Fixture();
        f.Seed(f.Playlist, "/p0.jpg", null, "/p1.jpg", "/p2.jpg", "/p3.jpg", "/p4.jpg");

        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));

        using var image = f.Image(f.Playlist);
        Assert.Equal((600, 600), (image.Width, image.Height));
        AssertColor(Colors[0], image.GetPixel(150, 150));
        AssertColor(Colors[3], image.GetPixel(450, 450));
        var marker = f.Service.Markers.Load(Fixture.Id(f.Playlist))!;
        Assert.Equal(new[] { "/p0.jpg", "/p1.jpg", "/p2.jpg", "/p3.jpg" }, marker.PosterKeys);
        Assert.Equal(4, f.PosterRequests.Count);
    }

    [Fact]
    public async Task ACollectionGetsAPosterShapedCollageInReleaseDateOrder()
    {
        using var f = new Fixture();
        var items = f.Seed(f.Collection, "/p0.jpg", "/p1.jpg");
        var doc = f.Store.LoadForUpdate(Fixture.Id(f.Collection), ListKinds.Collection);
        doc.Items.Single(i => i.Id == items[0].Id).ReleaseDate = "2020-01-01"; // now the later one
        f.Store.Save(doc);

        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Collection));

        using var image = f.Image(f.Collection);
        Assert.Equal((400, 600), (image.Width, image.Height));
        AssertColor(Colors[1], image.GetPixel(100, 300));
        AssertColor(Colors[0], image.GetPixel(300, 300));
    }

    [Fact]
    public async Task AnImageSomeoneSetIsNeverTouched()
    {
        using var f = new Fixture();
        f.Seed(f.Playlist, "/p0.jpg");
        f.Images.SetUserImage(f.Playlist.Info.Id);

        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        Assert.Empty(f.PosterRequests);
        Assert.Equal("/data/playlists/" + Fixture.Id(f.Playlist) + "/folder.jpg", f.Images.Images[f.Playlist.Info.Id].Path);

        // JE's collage replaced by an uploaded image: JE forgets its record and leaves the upload alone from then on.
        f.Images.Images.Remove(f.Playlist.Info.Id);
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        f.Images.SetUserImage(f.Playlist.Info.Id);
        f.Seed(f.Playlist, "/p1.jpg");
        Assert.Equal(CollageDecision.Forget, await f.Evaluate(f.Playlist));
        Assert.Null(f.Service.Markers.Load(Fixture.Id(f.Playlist)));
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        Assert.DoesNotContain(f.Images.Calls, c => c.StartsWith("delete:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AStaleCollageJellyfinGeneratedIsReplacedWhenTheListHasNoRealItemsLeft()
    {
        using var f = new Fixture();
        f.Seed(f.Playlist, "/p0.jpg");
        var movie = f.Host.AddItem();
        f.Playlist.Raw.Add(new RawEntry(movie, true));
        f.Images.SetJellyfinCollage(f.Playlist.Info.Id);

        // Seen while the list has a real item: recorded as Jellyfin's own collage, left alone.
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        Assert.NotNull(f.Service.NativeCollages.Load(Fixture.Id(f.Playlist)));

        f.Playlist.Raw.Clear();
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        Assert.EndsWith("/poster.jpg", f.Images.Images[f.Playlist.Info.Id].Path, StringComparison.Ordinal);
        Assert.Null(f.Service.NativeCollages.Load(Fixture.Id(f.Playlist)));
    }

    [Fact]
    public async Task AnUnmarkedImageInTheMetadataFolderIsNotReplacedWithoutProofJellyfinMadeIt()
    {
        // Jellyfin saves an upload in the list's internal metadata folder when the list's own folder isn't writable.
        using var f = new Fixture();
        f.Seed(f.Playlist, "/p0.jpg");
        var upload = f.Images.SetJellyfinCollage(f.Playlist.Info.Id, content: 2);

        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        Assert.Empty(f.PosterRequests);
        Assert.Same(upload, f.Images.Images[f.Playlist.Info.Id].Bytes);

        // A list that had Jellyfin's collage, then got an upload in that folder (same path, other content): kept too.
        var movie = f.Host.AddItem();
        f.Playlist.Raw.Add(new RawEntry(movie, true));
        f.Images.SetJellyfinCollage(f.Playlist.Info.Id, content: 4);
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        f.Playlist.Raw.Clear();
        upload = f.Images.SetJellyfinCollage(f.Playlist.Info.Id, content: 5);
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        Assert.Same(upload, f.Images.Images[f.Playlist.Info.Id].Bytes);
        Assert.DoesNotContain(f.Images.Calls, c => c.StartsWith("set:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ARealItemRemovesJesCollageAndRemovingItBringsItBack()
    {
        using var f = new Fixture();
        f.Seed(f.Playlist, "/p0.jpg", "/p1.jpg");
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));

        var movie = f.Host.AddItem();
        f.Playlist.Raw.Add(new RawEntry(movie, true));
        Assert.Equal(CollageDecision.Remove, await f.Evaluate(f.Playlist));
        Assert.False(f.Images.Images.ContainsKey(f.Playlist.Info.Id));
        Assert.Equal(new[] { "delete:" + Fixture.Id(f.Playlist), "refresh:" + Fixture.Id(f.Playlist) }, f.Images.Calls.Skip(1));
        Assert.Null(f.Service.Markers.Load(Fixture.Id(f.Playlist)));

        // Jellyfin builds its own collage from the real item: JE leaves it alone while the item is there.
        f.Images.SetJellyfinCollage(f.Playlist.Info.Id);
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));

        // A dangling (unresolved) entry is not a real item.
        f.Playlist.Raw.Clear();
        f.Playlist.Raw.Add(new RawEntry(Guid.NewGuid(), false));
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
    }

    [Fact]
    public async Task AnUnchangedPosterSetIsNotRenderedAgainButAChangedOneIs()
    {
        using var f = new Fixture();
        f.Seed(f.Playlist, "/p0.jpg", "/p1.jpg", "/p2.jpg", "/p3.jpg");
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        var requests = f.PosterRequests.Count;

        // A fifth placeholder after the first four changes nothing.
        f.Seed(f.Playlist, "/p4.jpg");
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        Assert.Equal(requests, f.PosterRequests.Count);
        Assert.Single(f.Images.Calls);

        // Moving it to the front does.
        var doc = f.Store.LoadForUpdate(Fixture.Id(f.Playlist), ListKinds.Playlist);
        var last = doc.Order[^1];
        doc.Order.RemoveAt(doc.Order.Count - 1);
        doc.Order.Insert(0, last);
        f.Store.Save(doc);
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        Assert.Equal(new[] { "/p4.jpg", "/p0.jpg", "/p1.jpg", "/p2.jpg" }, f.Service.Markers.Load(Fixture.Id(f.Playlist))!.PosterKeys);

        // Removing every poster removes the collage.
        doc = f.Store.LoadForUpdate(Fixture.Id(f.Playlist), ListKinds.Playlist);
        doc.Items.Clear();
        doc.Order.Clear();
        f.Store.Save(doc);
        Assert.Equal(CollageDecision.Remove, await f.Evaluate(f.Playlist));
    }

    [Fact]
    public async Task PostersTmdbDoesNotHaveAreSkippedAndNotRetriedButUnavailableOnesAre()
    {
        using var f = new Fixture();
        f.Seed(f.Playlist, "/missing.jpg", "/p1.jpg", "/down.jpg", "/p2.jpg");

        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        var marker = f.Service.Markers.Load(Fixture.Id(f.Playlist))!;
        Assert.Equal(new[] { "/p1.jpg", "/p2.jpg" }, marker.PosterKeys);
        Assert.Equal(new[] { "/missing.jpg" }, marker.FailedKeys);

        // Before its retry is due the unavailable poster isn't asked for, and the same collage isn't written again.
        f.PosterRequests.Clear();
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        Assert.Empty(f.PosterRequests);
        Assert.Single(f.Images.Calls);
        Assert.NotNull(f.Service.PendingDue(Fixture.Id(f.Playlist)));
    }

    [Fact]
    public async Task AnUnavailablePosterIsRetriedLaterWithoutRewritingTheSameCollage()
    {
        using var f = new Fixture();
        f.Service.RetryBase = TimeSpan.FromMilliseconds(150);
        f.Service.RetryMax = TimeSpan.FromSeconds(10);
        f.Seed(f.Playlist, "/missing.jpg", "/p1.jpg", "/p3.jpg", "/p2.jpg");
        f.Down.Add("p3");
        var id = Fixture.Id(f.Playlist);
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        Assert.Equal(new[] { "/p1.jpg", "/p2.jpg" }, f.Service.Markers.Load(id)!.PosterKeys);
        var firstRetry = f.Service.RetryUntil(id)!.Value;
        Assert.NotNull(f.Service.PendingDue(id));

        // Due: only the unavailable poster is asked for again (TMDB doesn't have the missing one). It fails again, so
        // the collage of the same posters is not written again, and the next retry waits longer.
        await Task.Delay(200);
        f.PosterRequests.Clear();
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        Assert.Contains("/t/p/w342/p3.jpg", f.PosterRequests);
        Assert.DoesNotContain("/t/p/w342/missing.jpg", f.PosterRequests);
        Assert.Single(f.Images.Calls, c => c.StartsWith("set:", StringComparison.Ordinal));
        Assert.True(f.Service.RetryUntil(id)!.Value - firstRetry > TimeSpan.FromMilliseconds(150));

        // Back: the next due retry adds it, and nothing waits any more.
        f.Down.Clear();
        await Task.Delay(350);
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        Assert.Equal(new[] { "/p1.jpg", "/p3.jpg", "/p2.jpg" }, f.Service.Markers.Load(id)!.PosterKeys);
        Assert.Null(f.Service.RetryUntil(id));
    }

    [Fact]
    public async Task AFlakyPosterNeverMakesJesOwnImageWritesLoop()
    {
        // Jellyfin raises ItemUpdated from JE's own image write (LibraryManager.UpdateItemsAsync), which queues another
        // pass: with a poster that keeps failing, that pass must not write (and so re-trigger) again.
        using var f = new Fixture();
        f.Seed(f.Playlist, "/p0.jpg", "/p1.jpg", "/p2.jpg");
        f.Down.Add("p1");
        var playlist = new MediaBrowser.Controller.Playlists.Playlist { Id = f.Playlist.Info.Id };
        f.Images.AfterWrite = _ => f.Library.Raise(l => l.ItemUpdated += null, f.Library.Object, new ItemChangeEventArgs { Item = playlist, UpdateReason = ItemUpdateType.ImageUpdate });
        await f.Service.StartAsync(CancellationToken.None);
        try
        {
            f.Service.Notify(Fixture.Id(f.Playlist));
            await Task.Delay(1500); // 30 debounce periods

            Assert.Single(f.Images.Calls, c => c.StartsWith("set:", StringComparison.Ordinal));
            Assert.InRange(f.Service.Evaluations, 2, 3); // the first pass and the one JE's write triggered
            Assert.Equal(1, f.PosterRequests.Count(r => r == "/t/p/w342/p1.jpg"));
            Assert.Equal(new[] { "/p0.jpg", "/p2.jpg" }, f.Service.Markers.Load(Fixture.Id(f.Playlist))!.PosterKeys);
        }
        finally
        {
            await f.Service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task NoDownloadableOrNoValidPosterMeansNoCollage()
    {
        using var f = new Fixture();
        f.Seed(f.Playlist, "/down.jpg", null);
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        Assert.Empty(f.Images.Images);

        f.Seed(f.Collection, (string?)null);
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Collection));
        Assert.Empty(f.Images.Calls);
    }

    [Fact]
    public async Task TurnedOffItDoesNothingExceptTakeBackItsOwnCollage()
    {
        using var f = new Fixture();
        f.Seed(f.Playlist, "/p0.jpg");
        f.Seed(f.Collection, "/p1.jpg");
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        f.Images.SetUserImage(f.Collection.Info.Id);

        f.Plugin.Plugin.Configuration.ListPlaceholdersPosterCollage = false;
        var other = f.Host.AddPlaylist(FakeListHost.MakeUser("o"));
        f.Seed(other, "/p2.jpg");
        Assert.Equal(CollageDecision.None, await f.Evaluate(other));
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Collection));
        Assert.Equal(CollageDecision.Remove, await f.Evaluate(f.Playlist));
        Assert.False(f.Images.Images.ContainsKey(f.Playlist.Info.Id));
        Assert.True(f.Images.Images.ContainsKey(f.Collection.Info.Id));

        // The master switch off counts as off too.
        f.Plugin.Plugin.Configuration.ListPlaceholdersPosterCollage = true;
        f.Plugin.Plugin.Configuration.ListPlaceholdersEnabled = false;
        Assert.Equal(CollageDecision.None, await f.Evaluate(other));
        Assert.DoesNotContain(other.Info.Id, f.Images.Images.Keys);
    }

    [Fact]
    public async Task ADeletedListIsLeftAloneAndItsRecordForgotten()
    {
        using var f = new Fixture();
        f.Seed(f.Playlist, "/p0.jpg");
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));

        f.Host.Lists.Remove(f.Playlist.Info.Id);
        Assert.Equal(CollageDecision.Forget, await f.Evaluate(f.Playlist));
        Assert.Null(f.Service.Markers.Load(Fixture.Id(f.Playlist)));
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        Assert.Equal(CollageDecision.None, await f.Service.EvaluateAsync("not-an-id", CancellationToken.None));
        Assert.Single(f.Images.Calls);
    }

    [Fact]
    public async Task ImageHostFailuresAreLoggedNotThrown()
    {
        using var f = new Fixture();
        f.Seed(f.Playlist, "/p0.jpg");
        var broken = new Mock<IListImageHost>();
        broken.Setup(h => h.GetPrimaryImage(It.IsAny<Guid>())).Throws(new InvalidOperationException("boom"));
        using var service = f.NewService(broken.Object);

        Assert.Equal(CollageDecision.None, await service.EvaluateAsync(Fixture.Id(f.Playlist), CancellationToken.None));
    }

    [Fact]
    public async Task ALinkedListSyncGivesTheListACollageAndARealArrivalTakesItBack()
    {
        // Linked-list sync writes documents only through ListPlaceholderStore.Save, so its Changed event drives the collage.
        using var f = new Fixture();
        f.Plugin.Plugin.Configuration.ListPlaceholdersSyncEnabled = true;
        var owner = f.H.NewUser("linker");
        var list = f.Host.AddPlaylist(owner);
        var access = f.H.AccessFor(list, owner);
        foreach (var tmdb in new[] { 1, 2 })
        {
            f.H.MovieDetails[tmdb] = "{\"id\":" + tmdb + ",\"posterPath\":\"/p" + tmdb + ".jpg\"}"; // the poster Seerr has
            f.H.Lookup.Details[("movie", tmdb)] = new TitleDetails(
                new TitleHit("movie", tmdb, "Movie " + tmdb, null, "2020-01-01", "/p" + tmdb + ".jpg", null, 10, 1000),
                null, null, "Released", null, Array.Empty<SeasonFacts>());
        }

        static SourceItem Item(int tmdb) => new("movie", tmdb, null, null, "Movie " + tmdb, 2020, null, null, null);
        f.H.Fetcher.Items = new() { Item(1), Item(2) };
        await f.Service.StartAsync(CancellationToken.None);
        try
        {
            var link = await f.H.Sources.LinkAsync(access, new LinkSourceRequest { Url = "https://mdblist.com/lists/me/dc", SyncEnabled = true }, CancellationToken.None);
            Assert.Equal(200, link.StatusCode);
            Assert.Equal(2, (await f.H.Sources.SyncAsync(access.ListIdN, background: true, CancellationToken.None)).Added);
            await Task.Delay(20);
            await f.Service.WhenIdleAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(new[] { "/p1.jpg", "/p2.jpg" }, f.Service.Markers.Load(access.ListIdN)!.PosterKeys);
            Assert.True(f.Images.Images.ContainsKey(list.Info.Id));

            // The source gains a title the library has: the sync adds the real item and the collage goes.
            var real = f.Host.AddItem(tmdb: 862);
            f.H.Library.Matches[("movie", 862)] = new LibraryMatch(real, "movie", Array.Empty<Guid>(), true);
            f.H.Lookup.Details[("movie", 862)] = new TitleDetails(
                new TitleHit("movie", 862, "Toy Story", null, "1995-11-22", "/p3.jpg", null, 10, 1000),
                null, null, "Released", null, Array.Empty<SeasonFacts>());
            f.H.Fetcher.Items = new() { Item(862), Item(1), Item(2) };
            Assert.Equal(1, (await f.H.Sources.SyncAsync(access.ListIdN, background: true, CancellationToken.None)).Added);
            await Task.Delay(20);
            await f.Service.WhenIdleAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(new[] { real }, f.Host.Resolved(list.Info.Id));
            Assert.False(f.Images.Images.ContainsKey(list.Info.Id));
            Assert.Null(f.Service.Markers.Load(access.ListIdN));
            Assert.Contains("refresh:" + access.ListIdN, f.Images.Calls);
        }
        finally
        {
            await f.Service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task DocumentChangesAreDebouncedPerListAndCoalesced()
    {
        using var f = new Fixture();
        var changed = new List<string>();
        f.Store.Changed += changed.Add;
        f.Service.Debounce = TimeSpan.FromMilliseconds(400);
        f.Service.MaxDelay = TimeSpan.FromSeconds(5);
        await f.Service.StartAsync(CancellationToken.None);
        try
        {
            f.Seed(f.Playlist, "/p0.jpg");
            f.Seed(f.Playlist, "/p1.jpg");
            f.Seed(f.Playlist, "/p2.jpg");
            await Task.Delay(20);
            await f.Service.WhenIdleAsync(TimeSpan.FromSeconds(10));

            Assert.Equal(1, f.Service.Evaluations);
            Assert.Equal(new[] { "/p0.jpg", "/p1.jpg", "/p2.jpg" }, f.Service.Markers.Load(Fixture.Id(f.Playlist))!.PosterKeys);
            Assert.Equal(3, changed.Count);

            // Deleting the document (list deleted) also triggers: the record of the removed list goes away.
            f.Host.Lists.Remove(f.Playlist.Info.Id);
            f.Store.Delete(Fixture.Id(f.Playlist));
            await Task.Delay(20);
            await f.Service.WhenIdleAsync(TimeSpan.FromSeconds(10));
            Assert.Null(f.Service.Markers.Load(Fixture.Id(f.Playlist)));
            Assert.Equal(new[] { Fixture.Id(f.Playlist) }, changed.Distinct());

            // QueueAll covers every document.
            f.Seed(f.Collection, "/p3.jpg");
            await f.Service.WhenIdleAsync(TimeSpan.FromSeconds(10));
            f.Images.Images.Clear();
            f.Service.QueueAll();
            await Task.Delay(20);
            await f.Service.WhenIdleAsync(TimeSpan.FromSeconds(10));
            Assert.True(f.Images.Images.ContainsKey(f.Collection.Info.Id));
        }
        finally
        {
            await f.Service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task TurningTheSettingOffAndOnRemovesAndRestoresCollages()
    {
        using var f = new Fixture();
        f.Seed(f.Playlist, "/p0.jpg");
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        await f.Service.StartAsync(CancellationToken.None);
        try
        {
            var off = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration { ListPlaceholdersEnabled = true, ListPlaceholdersPosterCollage = false };
            f.Plugin.Plugin.UpdateConfiguration(off);
            await Task.Delay(20);
            await f.Service.WhenIdleAsync(TimeSpan.FromSeconds(10));
            Assert.False(f.Images.Images.ContainsKey(f.Playlist.Info.Id));

            var on = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration { ListPlaceholdersEnabled = true, ListPlaceholdersPosterCollage = true };
            f.Plugin.Plugin.UpdateConfiguration(on);
            await Task.Delay(20);
            await f.Service.WhenIdleAsync(TimeSpan.FromSeconds(10));
            Assert.True(f.Images.Images.ContainsKey(f.Playlist.Info.Id));
        }
        finally
        {
            await f.Service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task NativeListEditsAndImageUpdatesTriggerAnEvaluation()
    {
        using var f = new Fixture();
        f.Seed(f.Playlist, "/p0.jpg");
        await f.Service.StartAsync(CancellationToken.None);
        try
        {
            await Task.Delay(20);
            await f.Service.WhenIdleAsync(TimeSpan.FromSeconds(10));
            var before = f.Service.Evaluations;
            var playlist = new MediaBrowser.Controller.Playlists.Playlist { Id = f.Playlist.Info.Id };
            // Image updates count: that is how JE sees the collage Jellyfin builds for a list with items.
            f.Library.Raise(l => l.ItemUpdated += null, f.Library.Object, new ItemChangeEventArgs { Item = playlist, UpdateReason = ItemUpdateType.ImageUpdate });
            await Task.Delay(20);
            await f.Service.WhenIdleAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(before + 1, f.Service.Evaluations);

            f.Library.Raise(l => l.ItemUpdated += null, f.Library.Object, new ItemChangeEventArgs { Item = playlist, UpdateReason = ItemUpdateType.MetadataEdit });
            await Task.Delay(20);
            await f.Service.WhenIdleAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(before + 2, f.Service.Evaluations);

            // Other items don't.
            f.Library.Raise(l => l.ItemUpdated += null, f.Library.Object, new ItemChangeEventArgs { Item = new MediaBrowser.Controller.Entities.Movies.Movie(), UpdateReason = ItemUpdateType.MetadataEdit });
            await Task.Delay(120);
            await f.Service.WhenIdleAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(before + 2, f.Service.Evaluations);
        }
        finally
        {
            await f.Service.StopAsync(CancellationToken.None);
        }
    }

    // ---- review round: parental controls, turning off mid-build, ownership races, corrupt posters ------------------

    [Fact]
    public async Task RestrictedViewersOnlyGetPostersEveryOneOfThemMaySee()
    {
        using var f = new Fixture();
        f.H.MovieCertifications[1000] = "R";
        f.H.MovieCertifications[1001] = "PG";
        f.H.MovieCertifications[1002] = "G";
        f.H.MovieCertifications[1003] = "R";
        f.H.MovieCertifications[1004] = "PG";
        f.Seed(f.Playlist, "/p0.jpg", "/p1.jpg", "/p2.jpg", "/p3.jpg", "/p4.jpg");
        // A custom (unverifiable) entry first: restricted viewers never see those.
        var doc = f.Store.LoadForUpdate(Fixture.Id(f.Playlist), ListKinds.Playlist);
        var custom = new Placeholder { Id = Guid.NewGuid().ToString("N"), Kind = PlaceholderKinds.Custom, Title = "Fan edit", PosterPath = "/p5.jpg" };
        doc.Items.Add(custom);
        doc.Order.Insert(0, ListPlaceholderOrder.PlaceholderToken(custom.Id));
        f.Store.Save(doc);

        // Only unrestricted users: every poster, in list order.
        f.AllUsers.Add(FakeListHost.MakeUser("adult"));
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        Assert.Equal(new[] { "/p5.jpg", "/p0.jpg", "/p1.jpg", "/p2.jpg" }, f.Service.Markers.Load(Fixture.Id(f.Playlist))!.PosterKeys);

        // A child who can see the list: only what the child's rows show (PG and G titles).
        var kid = f.Kid();
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        Assert.Equal(new[] { "/p1.jpg", "/p2.jpg", "/p4.jpg" }, f.Service.Markers.Load(Fixture.Id(f.Playlist))!.PosterKeys);
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));

        // The list hidden from the child: the child's filter no longer applies.
        f.Host.ListHiddenFrom[kid.Id] = new HashSet<Guid> { f.Playlist.Info.Id };
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        Assert.Equal(new[] { "/p5.jpg", "/p0.jpg", "/p1.jpg", "/p2.jpg" }, f.Service.Markers.Load(Fixture.Id(f.Playlist))!.PosterKeys);

        // Nothing the child may see: no collage at all (JE's is taken back).
        f.Host.ListHiddenFrom.Clear();
        var rated = f.Host.AddCollection();
        f.Seed(rated, "/p0.jpg");
        f.H.MovieCertifications[1000] = "R";
        f.AllUsers.Remove(kid);
        Assert.Equal(CollageDecision.Set, await f.Evaluate(rated));
        f.AllUsers.Add(kid);
        Assert.Equal(CollageDecision.Remove, await f.Evaluate(rated));
        Assert.False(f.Images.Images.ContainsKey(rated.Info.Id));
    }

    [Fact]
    public async Task AParentalControlChangeReChecksTheCollages()
    {
        using var f = new Fixture();
        f.H.MovieCertifications[1000] = "R";
        f.H.MovieCertifications[1001] = "PG";
        f.Seed(f.Playlist, "/p0.jpg", "/p1.jpg");
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        await f.Service.StartAsync(CancellationToken.None);
        try
        {
            var kid = f.Kid();
            f.H.Users.Raise(u => u.OnUserUpdated += null, f.H.Users.Object, new GenericEventArgs<User>(kid));
            await Task.Delay(20);
            await f.Service.WhenIdleAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(new[] { "/p1.jpg" }, f.Service.Markers.Load(Fixture.Id(f.Playlist))!.PosterKeys);
        }
        finally
        {
            await f.Service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task TurningItOffWhileAFirstCollageDownloadsLeavesNoCollage()
    {
        using var f = new Fixture();
        f.Seed(f.Playlist, "/slow.jpg");
        await f.Service.StartAsync(CancellationToken.None);
        try
        {
            f.Service.Notify(Fixture.Id(f.Playlist));
            await f.SlowRequested.Task.WaitAsync(TimeSpan.FromSeconds(10));
            f.Plugin.Plugin.UpdateConfiguration(new Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration { ListPlaceholdersEnabled = true, ListPlaceholdersPosterCollage = false });
            f.SlowGate.SetResult();
            await Task.Delay(20);
            await f.Service.WhenIdleAsync(TimeSpan.FromSeconds(10));

            Assert.Empty(f.Images.Images);
            Assert.Null(f.Service.Markers.Load(Fixture.Id(f.Playlist)));
        }
        finally
        {
            await f.Service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task WhileOffTheStartupPassTakesBackACollageLeftBehind()
    {
        using var f = new Fixture();
        f.Seed(f.Playlist, "/p0.jpg");
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));

        // Off without a ConfigurationChanged transition (e.g. the config was edited while the server was stopped).
        f.Plugin.Plugin.Configuration.ListPlaceholdersEnabled = false;
        f.Service.StartupDelay = TimeSpan.FromMilliseconds(10);
        await f.Service.StartAsync(CancellationToken.None);
        try
        {
            await Task.Delay(100);
            await f.Service.WhenIdleAsync(TimeSpan.FromSeconds(10));
            Assert.Empty(f.Images.Images);
            Assert.Null(f.Service.Markers.Load(Fixture.Id(f.Playlist)));
        }
        finally
        {
            await f.Service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task WhileOffTheMaintenanceTaskTakesBackACollageLeftBehind()
    {
        using var f = new Fixture();
        f.Seed(f.Playlist, "/p0.jpg");
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        await f.Service.StartAsync(CancellationToken.None);
        try
        {
            f.Plugin.Plugin.Configuration.ListPlaceholdersEnabled = false;
            var lifecycle = new ListPlaceholderLifecycle(new Mock<ILibraryManager>().Object, f.Store, f.Host, f.Plugin.Core.Logger);
            var task = new ListPlaceholdersMaintenanceTask(f.H.Swap, lifecycle, f.Plugin.Core.Logger, f.Service);
            await task.ExecuteAsync(new Progress<double>(), CancellationToken.None);
            await Task.Delay(20);
            await f.Service.WhenIdleAsync(TimeSpan.FromSeconds(10));
            Assert.Empty(f.Images.Images);
        }
        finally
        {
            await f.Service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task AnImageSetRightBeforeJesWriteOrDeleteWins()
    {
        using var f = new Fixture();
        var id = f.Playlist.Info.Id;
        f.Seed(f.Playlist, "/p0.jpg");

        // An upload landing between JE's last check and its write: nothing is written.
        f.Images.BeforeWrite = list => { f.Images.SetUserImage(list); f.Images.BeforeWrite = null; };
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        Assert.EndsWith("/folder.jpg", f.Images.Images[id].Path, StringComparison.Ordinal);
        Assert.Null(f.Service.Markers.Load(Fixture.Id(f.Playlist)));

        // An upload landing right before JE removes its collage: the upload stays.
        f.Images.Images.Remove(id);
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        f.Playlist.Raw.Add(new RawEntry(f.Host.AddItem(), true));
        f.Images.BeforeWrite = list => { f.Images.SetUserImage(list); f.Images.BeforeWrite = null; };
        Assert.Equal(CollageDecision.Forget, await f.Evaluate(f.Playlist));
        Assert.EndsWith("/folder.jpg", f.Images.Images[id].Path, StringComparison.Ordinal);
        Assert.Null(f.Service.Markers.Load(Fixture.Id(f.Playlist)));
        Assert.DoesNotContain(f.Images.Calls, c => c.StartsWith("refresh:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ACorruptPosterIsSkippedForTheNextOneAndNotRetried()
    {
        Assert.False(ListPlaceholderCollageRenderer.CanDecode(Truncated(Poster(Colors[0]))));
        Assert.True(ListPlaceholderCollageRenderer.CanDecode(Poster(Colors[0])));
        Assert.Null(ListPlaceholderCollageRenderer.Render(new[] { Truncated(Poster(Colors[0])) }, true));

        using var f = new Fixture();
        f.Seed(f.Playlist, "/corrupt.jpg", "/p1.jpg", "/p2.jpg", "/p3.jpg", "/p4.jpg");
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        var marker = f.Service.Markers.Load(Fixture.Id(f.Playlist))!;
        Assert.Equal(new[] { "/p1.jpg", "/p2.jpg", "/p3.jpg", "/p4.jpg" }, marker.PosterKeys);
        Assert.Equal(new[] { "/corrupt.jpg" }, marker.FailedKeys);

        f.PosterRequests.Clear();
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        Assert.Empty(f.PosterRequests);
    }

    // ---- review round 2: fail closed, no rewrite loop, upload provenance, orphaned records ------------------------

    [Fact]
    public async Task ACollageShowingAPosterARestrictedViewerMayNotSeeIsTakenDownWhenItCantBeRebuilt()
    {
        using var f = new Fixture();
        f.Service.RetryBase = TimeSpan.FromMilliseconds(100);
        f.H.MovieCertifications[1000] = "R";
        f.H.MovieCertifications[1001] = "PG";
        f.Seed(f.Playlist, "/p0.jpg", "/p1.jpg");
        var id = Fixture.Id(f.Playlist);
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        Assert.Equal(new[] { "/p0.jpg", "/p1.jpg" }, f.Service.Markers.Load(id)!.PosterKeys);

        // A viewer gets parental controls while TMDB can't serve the PG poster: the R poster must not stay up.
        f.Kid();
        f.Down.Add("p1");
        Assert.Equal(CollageDecision.Remove, await f.Evaluate(f.Playlist));
        Assert.False(f.Images.Images.ContainsKey(f.Playlist.Info.Id));
        Assert.Null(f.Service.Markers.Load(id));
        Assert.Contains("refresh:" + id, f.Images.Calls);
        Assert.NotNull(f.Service.RetryUntil(id));
        Assert.NotNull(f.Service.PendingDue(id));

        // The retry builds the allowed collage once the poster is back.
        f.Down.Clear();
        await Task.Delay(150);
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        Assert.Equal(new[] { "/p1.jpg" }, f.Service.Markers.Load(id)!.PosterKeys);

        // Without restricted viewers a failed rebuild keeps the collage (nothing in it is hidden from anyone).
        f.AllUsers.Clear();
        var other = f.Host.AddPlaylist(FakeListHost.MakeUser("o"));
        f.Seed(other, "/p2.jpg");
        Assert.Equal(CollageDecision.Set, await f.Evaluate(other));
        var doc = f.Store.LoadForUpdate(Fixture.Id(other), ListKinds.Playlist);
        doc.Items[0].PosterPath = "/p3.jpg";
        f.Store.Save(doc);
        f.Down.Add("p3");
        Assert.Equal(CollageDecision.None, await f.Evaluate(other));
        Assert.True(f.Images.Images.ContainsKey(other.Info.Id));
    }

    [Fact]
    public async Task ACollageWhoseRebuildWriteFailsIsTakenDownWhenItShowsAHiddenPoster()
    {
        using var f = new Fixture();
        f.H.MovieCertifications[1000] = "R";
        f.H.MovieCertifications[1001] = "PG";
        f.Seed(f.Playlist, "/p0.jpg", "/p1.jpg");
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));

        f.Kid();
        f.Images.WriteException = new IOException("disk full");
        Assert.Equal(CollageDecision.Remove, await f.Evaluate(f.Playlist));
        Assert.False(f.Images.Images.ContainsKey(f.Playlist.Info.Id));
        Assert.Null(f.Service.Markers.Load(Fixture.Id(f.Playlist)));

        // The next pass sets the allowed collage.
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        Assert.Equal(new[] { "/p1.jpg" }, f.Service.Markers.Load(Fixture.Id(f.Playlist))!.PosterKeys);
    }

    [Fact]
    public async Task AnUploadJellyfinSavedInTheMetadataFolderIsKeptWhenTheLastRealItemLeaves()
    {
        // The list's own folder isn't writable, so Jellyfin saved the upload in the internal metadata folder while the
        // list had a real item. Only a 600x600 PNG on a playlist has the shape of Jellyfin's own collage.
        using var f = new Fixture();
        var uploads = new (FakeListHost.FakeList List, string Name, byte[] Bytes)[]
        {
            (f.Playlist, "poster.jpg", new byte[] { 0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3 }),
            (f.Host.AddPlaylist(FakeListHost.MakeUser("o")), "poster.png", Poster(Colors[1], 800, 800)),
            (f.Collection, "poster.png", Poster(Colors[2], 600, 600)),
            (f.Host.AddCollection(), "poster.jpg", new byte[] { 0xFF, 0xD8, 0xFF, 0xE0, 4, 5, 6 }),
        };
        foreach (var (list, name, bytes) in uploads)
        {
            f.Seed(list, "/p0.jpg");
            list.Raw.Add(new RawEntry(f.Host.AddItem(), true));
            f.Images.SetMetadataImage(list.Info.Id, name, bytes);
            Assert.Equal(CollageDecision.None, await f.Evaluate(list));
            Assert.Null(f.Service.NativeCollages.Load(Fixture.Id(list)));

            list.Raw.Clear();
            Assert.Equal(CollageDecision.None, await f.Evaluate(list));
            Assert.Same(bytes, f.Images.Images[list.Info.Id].Bytes);
        }

        Assert.DoesNotContain(f.Images.Calls, c => c.StartsWith("set:", StringComparison.Ordinal));
        Assert.Empty(f.PosterRequests);
    }

    [Fact]
    public async Task TheRecordOfJellyfinsCollageGoesAwayWithItsList()
    {
        using var f = new Fixture();
        var id = Fixture.Id(f.Playlist);
        f.Seed(f.Playlist, "/p0.jpg");
        f.Playlist.Raw.Add(new RawEntry(f.Host.AddItem(), true));
        f.Images.SetJellyfinCollage(f.Playlist.Info.Id);
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        Assert.NotNull(f.Service.NativeCollages.Load(id));

        // The list is deleted: its document goes first, then the pass that follows sees the list is gone.
        f.Host.Lists.Remove(f.Playlist.Info.Id);
        f.Store.Delete(id);
        Assert.Equal(CollageDecision.None, await f.Evaluate(f.Playlist));
        Assert.Null(f.Service.NativeCollages.Load(id));

        // Deleted while the feature was off (no pass then): the startup / maintenance pass while off still cleans up.
        var other = f.Host.AddPlaylist(FakeListHost.MakeUser("o"));
        var otherId = Fixture.Id(other);
        f.Seed(other, "/p1.jpg");
        other.Raw.Add(new RawEntry(f.Host.AddItem(), true));
        f.Images.SetJellyfinCollage(other.Info.Id);
        Assert.Equal(CollageDecision.None, await f.Evaluate(other));
        Assert.NotNull(f.Service.NativeCollages.Load(otherId));
        f.Plugin.Plugin.Configuration.ListPlaceholdersPosterCollage = false;
        f.Host.Lists.Remove(other.Info.Id);
        f.Store.Delete(otherId);
        await f.Service.StartAsync(CancellationToken.None);
        try
        {
            f.Service.QueueMarkers();
            await Task.Delay(20);
            await f.Service.WhenIdleAsync(TimeSpan.FromSeconds(10));
            Assert.Null(f.Service.NativeCollages.Load(otherId));
        }
        finally
        {
            await f.Service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public void PngSizesAreReadFromTheFileHeader()
    {
        Assert.Equal((600, 600), ListImageHeader.PngSize(Poster(Colors[0], 600, 600)));
        Assert.Equal((342, 513), ListImageHeader.PngSize(Poster(Colors[0])));
        Assert.Null(ListImageHeader.PngSize(new byte[] { 0xFF, 0xD8, 0xFF, 0xE0 }));
        Assert.Null(ListImageHeader.PngSize(Poster(Colors[0])[..20]));

        var dir = Directory.CreateTempSubdirectory("je-collage-png-");
        try
        {
            var host = new JellyfinListImageHost(new Mock<ILibraryManager>().Object, new Mock<MediaBrowser.Controller.Providers.IProviderManager>().Object, new Mock<MediaBrowser.Model.IO.IFileSystem>().Object, new Mock<MediaBrowser.Common.Configuration.IApplicationPaths>().Object);
            var png = Path.Combine(dir.FullName, "poster.png");
            File.WriteAllBytes(png, Poster(Colors[0], 600, 600));
            var jpg = Path.Combine(dir.FullName, "poster.jpg");
            File.WriteAllBytes(jpg, new byte[] { 0xFF, 0xD8, 0xFF });
            Assert.Equal((600, 600), host.GetPngSize(png));
            Assert.Null(host.GetPngSize(jpg));
            Assert.Null(host.GetPngSize(Path.Combine(dir.FullName, "missing.png")));
        }
        finally
        {
            dir.Delete(true);
        }
    }

    // ---- review round 3: TMDB posters without Seerr, re-checks after a provider outage ----------------------------

    // R3-11: with Seerr off and a TMDB key set, restricted viewers' collages use TMDB's poster of each title (as the
    // stored posters are then TMDB's), not none at all.
    [Fact]
    public async Task WithoutSeerrRestrictedViewersGetTmdbPosters()
    {
        using var f = new Fixture();
        f.Plugin.Plugin.Configuration.JellyseerrEnabled = false;
        f.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        f.Kid();
        var seeded = f.Seed(f.Playlist, "/p5.jpg", "/p6.jpg");
        f.H.Tmdb["/3/movie/1000"] = "{\"id\":1000,\"poster_path\":\"/p0.jpg\"}";
        f.H.Tmdb["/3/movie/1000/release_dates"] = "{\"id\":1000,\"results\":[{\"iso_3166_1\":\"US\",\"release_dates\":[{\"certification\":\"PG\",\"type\":3}]}]}";
        f.H.Tmdb["/3/movie/1001"] = "{\"id\":1001,\"poster_path\":\"/p1.jpg\"}";
        f.H.Tmdb["/3/movie/1001/release_dates"] = "{\"id\":1001,\"results\":[{\"iso_3166_1\":\"US\",\"release_dates\":[{\"certification\":\"R\",\"type\":3}]}]}";
        Assert.Equal(2, seeded.Count);

        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        Assert.Equal(new[] { "/p0.jpg" }, f.Service.Markers.Load(Fixture.Id(f.Playlist))!.PosterKeys);
        Assert.DoesNotContain(f.H.SeerrCalls, c => c.StartsWith("/api/v1/", StringComparison.Ordinal));
    }

    // R3-10: a restricted list whose posters can't be verified because Seerr is down loses its collage (fail closed),
    // and is checked again later: Seerr coming back fires no event.
    [Fact]
    public async Task ACollageRemovedWhileSeerrWasDownIsBuiltAgainOnceItAnswers()
    {
        using var f = new Fixture();
        f.Service.RetryBase = TimeSpan.FromMilliseconds(100);
        f.H.MovieCertifications[1000] = "PG";
        var seeded = f.Seed(f.Playlist, "/p0.jpg");
        var id = Fixture.Id(f.Playlist);
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));

        // A viewer with parental controls whose rating lookups are cached, then Seerr stops answering title details.
        var kid = f.Kid();
        Assert.Empty(await f.H.Access.GetHiddenPlaceholderIdsAsync(seeded, kid, CancellationToken.None));
        var seerr = f.H.Reply;
        f.H.Reply = request => request.RequestUri!.AbsolutePath.StartsWith("/api/v1/movie/", StringComparison.Ordinal)
            ? new HttpResponseMessage(HttpStatusCode.BadGateway)
            : seerr(request);
        Assert.Equal(CollageDecision.Remove, await f.Evaluate(f.Playlist));
        Assert.False(f.Images.Images.ContainsKey(f.Playlist.Info.Id));
        Assert.NotNull(f.Service.VerifyRetryUntil(id));
        Assert.NotNull(f.Service.PendingDue(id));

        // Seerr is back: the planned check builds the collage again and forgets the retry.
        f.H.Reply = seerr;
        await Task.Delay(150);
        Assert.Equal(CollageDecision.Set, await f.Evaluate(f.Playlist));
        Assert.Equal(new[] { "/p0.jpg" }, f.Service.Markers.Load(id)!.PosterKeys);
        Assert.Null(f.Service.VerifyRetryUntil(id));
    }
}
