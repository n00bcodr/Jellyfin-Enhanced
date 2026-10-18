using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using Moq;
using Rig = JE.Tests.IntegrationEditionAvailabilityTests.Rig;
using Layout = JE.Tests.IntegrationEditionAvailabilityTests.Layout;
using Has = JE.Tests.IntegrationEditionAvailabilityTests.Has;
using Part = JE.Tests.IntegrationEditionAvailabilityTests.Part;

namespace JE.Tests;

/// <summary>
/// Edition availability, review round 1: a version is credited only when the viewer can open the item that plays it
/// (library access and parental limits, Jellyfin's own check); a page pinned to one series copy reads only the Sonarr
/// that provably owns that copy's folder; every answer is judged by the viewer and items as they are after the arr
/// reads, never by what was read before them (a policy changed meanwhile); a standard whole-series request honours
/// "Standard requests need a non-4K copy"; a placeholder or a missing (virtual) movie never fulfils a request.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionReviewRound1Tests
{
    private const string Matrix = "movie:tmdb:603";
    private static readonly TitleKey Sintel = TitleKey.Parse("movie:tmdb:45745")!;
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    // ------------------------------------------------------------------ r1-1: the backing item of every version, as the viewer

    /// <summary>A movie whose media sources (one per version) are what Jellyfin's GetMediaSources lists.</summary>
    private sealed class VersionedMovie : Movie
    {
        public List<MediaSourceInfo> Versions { get; } = new();

        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Versions;
    }

    private static MediaSourceInfo Version(Guid id, string path, int width, int height) => new()
    {
        Id = id.ToString("N"),
        Path = path,
        Protocol = MediaProtocol.File,
        Type = MediaSourceType.Default,
        MediaStreams = new List<MediaStream> { new() { Type = MediaStreamType.Video, Width = width, Height = height } },
    };

    /// <summary>
    /// The real Jellyfin view over a library of The Matrix: a 1080p movie in Movies whose versions include a 2160p
    /// item in Movies 4K (a linked version), and the items each user may open (Jellyfin's GetItemById(id, user):
    /// library access and parental limits).
    /// </summary>
    private sealed class Library : IDisposable
    {
        public VersionedMovie Hd { get; }
        public VersionedMovie Uhd { get; }
        public Mock<ILibraryManager> Manager { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public Dictionary<Guid, HashSet<Guid>> Opens { get; } = new();
        public Dictionary<Guid, User> People { get; } = new();
        public ArrJellyfinView View { get; }
        private readonly ILibraryManager _previous = BaseItem.LibraryManager;

        public Library(DateTime created)
        {
            Hd = new VersionedMovie { Id = Guid.NewGuid(), Name = "The Matrix", Path = "/media/movies/The Matrix (1999)/The Matrix - 1080p.mkv", DateCreated = created };
            Uhd = new VersionedMovie { Id = Guid.NewGuid(), Name = "The Matrix", Path = "/media/movies4k/The Matrix (1999)/The Matrix - 2160p.mkv", DateCreated = created };
            Hd.SetProviderId(MetadataProvider.Tmdb, "603");
            Uhd.SetProviderId(MetadataProvider.Tmdb, "603");
            Hd.Versions.Add(Version(Hd.Id, Hd.Path, 1920, 1080));
            Hd.Versions.Add(Version(Uhd.Id, Uhd.Path, 3840, 2160));
            Uhd.Versions.Add(Version(Uhd.Id, Uhd.Path, 3840, 2160));
            var root = new CollectionFolder { Id = Guid.NewGuid(), Name = "Movies" };
            BaseItem? ById(Guid id) => id == Hd.Id ? Hd : id == Uhd.Id ? Uhd : id == root.Id ? root : null;
            Manager.Setup(l => l.GetVirtualFolders()).Returns(new List<VirtualFolderInfo> { new() { ItemId = root.Id.ToString("N") } });
            Manager.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.IncludeItemTypes.Contains(BaseItemKind.Movie) ? new List<BaseItem> { Hd } : new List<BaseItem>());
            Manager.Setup(l => l.GetCollectionFolders(It.IsAny<BaseItem>())).Returns(new List<Folder> { root });
            Manager.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => ById(id));
            Manager.Setup(l => l.FindByPath(It.IsAny<string>(), It.IsAny<bool?>())).Returns((string path, bool? _) => path == Uhd.Path ? Uhd : path == Hd.Path ? Hd : null);
            Manager.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>(), It.IsAny<User?>()))
                .Returns((Guid id, User? user) => user != null && Opens.TryGetValue(user.Id, out var open) && (id == root.Id || open.Contains(id)) ? ById(id) : null);
            Users.Setup(u => u.GetUserById(It.IsAny<Guid>())).Returns((Guid id) => People.GetValueOrDefault(id));
            View = new ArrJellyfinView(Manager.Object, Users.Object);
            // Jellyfin's items read their versions through the static library manager.
            BaseItem.LibraryManager = Manager.Object;
        }

        /// <summary>Registers a person (the handle a test view made) who may open <paramref name="open"/>.</summary>
        public StatusViewer Person(StatusViewer fake, bool admin, bool parental, params Guid[] open)
        {
            var user = (User)fake.Handle!;
            user.SetPermission(PermissionKind.IsAdministrator, admin);
            if (parental) user.MaxParentalRatingScore = 10;
            People[user.Id] = user;
            Opens[user.Id] = open.ToHashSet();
            return View.Viewer(user.Id)!;
        }

        public void Dispose()
        {
            View.Dispose();
            BaseItem.LibraryManager = _previous;
        }
    }

    [Fact]
    public async Task A4kVersionTheViewerCantOpenIsNotCreditedGet4kStaysAndTheirRequestIsNotFulfilled()
    {
        var lab = (IntegrationRequestArrivalsTests.Lab?)null;
        using var library = new Library(DateTime.UtcNow.AddDays(-1));
        using var l = lab = new IntegrationRequestArrivalsTests.Lab(fourK: true, jellyfin: library.View);
        lab.Policy.Adjust = (_, _, person) => person with { Can4k = true };
        // Emma can't open Movies 4K; the kid can't open the 2160p item (its rating); the admin opens both.
        var emma = library.Person(lab.Emma, admin: false, parental: false, library.Hd.Id);
        var kid = library.Person(lab.Kid, admin: false, parental: true, library.Hd.Id);
        var admin = library.Person(lab.Admin, admin: true, parental: false, library.Hd.Id, library.Uhd.Id);
        Assert.True(kid.HasParentalLimit);

        // Jellyfin's view: the HD item's versions, as each person may play them.
        Assert.DoesNotContain(library.View.Sources(library.Hd.Id, emma), s => s.Width == 3840);
        Assert.DoesNotContain(library.View.Sources(library.Hd.Id, kid), s => s.Width == 3840);
        Assert.Contains(library.View.Sources(library.Hd.Id, emma), s => s.Width == 1920);
        Assert.Contains(library.View.Sources(library.Hd.Id, admin), s => s.Width == 3840 && s.BackingItemId == library.Uhd.Id);
        // The server's library context (no person) still sees every version.
        Assert.Contains(library.View.Sources(library.Hd.Id, StatusViewer.Library), s => s.Width == 3840);
        var editions = lab.Status.Editions;
        var key = TitleKey.Parse(Matrix)!;
        Assert.Empty(editions.Scope(emma, key, Edition.FourK));
        Assert.Empty(editions.ScopeForAll(new[] { admin, emma }, key, Edition.FourK));
        Assert.Equal(library.Uhd.Id, Assert.Single(editions.ScopeForAll(new[] { admin }, key, Edition.FourK)).PlayableItemId);
        Assert.Single(editions.ScopeForAll(Array.Empty<StatusViewer>(), key, Edition.FourK));

        // The HD page: Get 4K stays for Emma and the kid (no 4K copy they can open), not for the admin.
        await lab.Warm();
        Assert.False(Items(await Page(lab, emma, library.Hd.Id))[0].TryGetProperty("fourK", out _));
        Assert.False(Items(await Page(lab, kid, library.Hd.Id))[0].TryGetProperty("fourK", out _));
        Assert.True(Items(await Page(lab, admin, library.Hd.Id))[0].GetProperty("fourK").GetBoolean());

        // Their 4K requests stay open: the 2160p version isn't theirs.
        var emma4k = await lab.Ask(lab.Emma, new MutationInput { Key = Matrix, Variant = "4k" });
        var kid4k = await lab.Ask(lab.Kid, new MutationInput { Key = Matrix, Variant = "4k" });
        await lab.Outbox.TickAsync(default);
        await lab.Fulfilment.CheckAsync(new[] { Matrix }, default);
        Assert.NotEqual("fulfilled", lab.Ledger.Find(emma4k)!.Status);
        Assert.NotEqual("fulfilled", lab.Ledger.Find(kid4k)!.Status);
    }

    [Fact]
    public async Task AVersionTheViewerCantOpenIsNotCountedAmongTheItemsVersions()
    {
        // One movie item in Movies with a 2160p version whose own item is in a library only the admin opens. The page's
        // version count (which also tells the page a version arrived) counts only what the viewer can play.
        using var rig = new Rig(Layout.OneItem, Has.Hd, movie: true);
        var uhd = rig.View.AddSource(rig.HdCopy, 3840, 2160, "/media/private/Sintel - 2160p.mkv");
        rig.View.AddItem(new JfItemRef { ItemId = uhd.BackingItemId, Kind = "movie", Key = Sintel, Path = "/media/private/Sintel - 2160p.mkv" }, rig.Admin.UserId);
        var item = rig.View.Items[rig.HdCopy].Ref;
        rig.View.Items[rig.HdCopy] = new FakeJellyfinView.Item(new JfItemRef { ItemId = item.ItemId, Kind = item.Kind, Key = item.Key, Path = item.Path, LibraryId = item.LibraryId, LibraryName = item.LibraryName, DateCreated = item.DateCreated, Versions = 2 }, null);
        rig.View.Rev++;
        Assert.Equal(1, Items(await Page(rig, rig.Member, rig.HdCopy))[0].GetProperty("versions").GetInt32());
        Assert.Equal(2, Items(await Page(rig, rig.Admin, rig.HdCopy))[0].GetProperty("versions").GetInt32());
    }

    [Fact]
    public async Task APlaceholderMovieNeverFulfilsAStandardRequest()
    {
        var lab = (IntegrationRequestArrivalsTests.Lab?)null;
        using var library = new Library(DateTime.UtcNow.AddDays(-1));
        // The Matrix in Jellyfin is a disc placeholder (no playable file).
        library.Hd.IsPlaceHolder = true;
        using var l = lab = new IntegrationRequestArrivalsTests.Lab(jellyfin: library.View);
        var emma = library.Person(lab.Emma, admin: false, parental: false, library.Hd.Id);
        await lab.Warm();
        var standard = await lab.Ask(lab.Emma, new MutationInput { Key = Matrix });
        await lab.Outbox.TickAsync(default);
        Assert.Equal(0, await lab.Fulfilment.CheckAsync(new[] { Matrix }, default));
        Assert.NotEqual("fulfilled", lab.Ledger.Find(standard)!.Status);
        Assert.NotEqual(StatusStage.Ready, Assert.Single(await lab.Status.ComposeForAsync(emma, new[] { TitleKey.Parse(Matrix)! }, new Dictionary<TitleKey, ArrStatusService.RequestScope> { [TitleKey.Parse(Matrix)!] = new(Array.Empty<int>(), false, null) }, default)).Status.Stage);
    }

    // ------------------------------------------------------------------ r1-2: a pinned series page reads only its own Sonarr

    /// <summary>Links every Sonarr to the one TV library (as many grouped setups do).</summary>
    private static void LinkSonarrsTo(Rig rig, string library)
    {
        var c = rig.Arr.Plugin.Plugin.Configuration;
        var rows = JsonNode.Parse(c.SonarrInstances)!.AsArray();
        foreach (var row in rows) row!["LinkedLibraryIds"] = new JsonArray(library);
        c.SonarrInstances = rows.ToJsonString();
    }

    private static Guid MissingEpisode(Rig rig, Guid series, int episode)
    {
        var id = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = id, Kind = "episode", Key = Firefly.WithEpisode(1, episode), SeriesId = series, Season = 1, Episode = episode, Virtual = true });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = id, Season = 1, Episode = episode, Virtual = true });
        rig.View.Rev++;
        return id;
    }

    private static JsonObject SonarrEpisode(int id, int number, bool hasFile)
        => new() { ["id"] = id, ["seriesId"] = 1, ["seasonNumber"] = 1, ["episodeNumber"] = number, ["airDateUtc"] = "2002-09-23T00:00:00Z", ["hasFile"] = hasFile, ["monitored"] = true };

    [Fact]
    public async Task AGroupedFourKFolderNeverReadsTheStandardSonarrOnlyBecauseBothShareTheLibrary()
    {
        // Firefly in one grouped TV library: the standard folder and the 4K folder. Only the standard Sonarr holds the
        // title (with S1E3's file, in the standard folder), and it is linked to the whole TV library.
        using var rig = new Rig(Layout.GroupedFolders, Has.Hd, movie: false);
        LinkSonarrsTo(rig, "TV");
        rig.Sonarr4k!.Series.Clear();
        rig.Sonarr4k.Episodes.Clear();
        rig.Sonarr.Episodes.Add(SonarrEpisode(103, 3, hasFile: true));
        var fourK = MissingEpisode(rig, rig.UhdCopy, 3);
        var standard = MissingEpisode(rig, rig.HdCopy, 3);
        await Page(rig, rig.Admin, fourK);
        await Task.Delay(20);

        // The 4K folder's missing S1E3: no Sonarr owns that folder, so nothing of the standard one's (no "Almost ready").
        foreach (var viewer in new[] { rig.Member, rig.Admin })
        {
            var page = Items(await Page(rig, viewer, fourK))[0];
            Assert.NotEqual(StatusStage.AlmostReady, page.GetProperty("stage").GetString());
            if (page.TryGetProperty("admin", out var admin) && admin.TryGetProperty("variants", out var variants))
                Assert.DoesNotContain(variants.EnumerateArray(), v => v.GetProperty("instance").GetString() == "SonarrZ");
        }
        // The standard folder's own page still reads its Sonarr.
        Assert.Equal(StatusStage.AlmostReady, Items(await Page(rig, rig.Member, standard))[0].GetProperty("stage").GetString());
    }

    [Fact]
    public async Task WhenBothSonarrsShareTheLibraryTheFoldersPathTellsWhoseCopyAPageIs()
    {
        // Both Sonarrs hold Firefly and are linked to the one grouped TV library; the standard one has S1E3's file,
        // the 4K one doesn't. Which Sonarr a page reads is decided by its own folder, not by role order.
        using var rig = new Rig(Layout.GroupedFolders, Has.Hd, movie: false);
        LinkSonarrsTo(rig, "TV");
        rig.Sonarr.Episodes.Add(SonarrEpisode(103, 3, hasFile: true));
        rig.Sonarr4k!.Episodes.Add(SonarrEpisode(103, 3, hasFile: false));
        var fourK = MissingEpisode(rig, rig.UhdCopy, 3);
        var standard = MissingEpisode(rig, rig.HdCopy, 3);
        await Page(rig, rig.Admin, fourK);
        await Task.Delay(20);

        var page = Items(await Page(rig, rig.Admin, fourK))[0];
        Assert.NotEqual(StatusStage.AlmostReady, page.GetProperty("stage").GetString());
        Assert.Equal("Sonarr4kZ", page.GetProperty("admin").GetProperty("variants")[0].GetProperty("instance").GetString());
        Assert.NotEqual(StatusStage.AlmostReady, Items(await Page(rig, rig.Member, fourK))[0].GetProperty("stage").GetString());
        var own = Items(await Page(rig, rig.Admin, standard))[0];
        Assert.Equal(StatusStage.AlmostReady, own.GetProperty("stage").GetString());
        Assert.Equal("SonarrZ", own.GetProperty("admin").GetProperty("variants")[0].GetProperty("instance").GetString());
    }

    // ------------------------------------------------------------------ r1-3: one final gate after the arr reads

    /// <summary>Runs <paramref name="change"/> once, the first time the status service reads the title's copies (inside its arr reads).</summary>
    private static void DuringTheArrReads(FakeJellyfinView view, Action change)
    {
        var done = false;
        view.OnCopies = () =>
        {
            if (done) return;
            done = true;
            change();
            view.Rev++;
        };
    }

    private static async Task<Rig> WarmMovie()
    {
        var rig = new Rig(Layout.OneItem, Has.Hd, movie: true);
        await Page(rig, rig.Admin, rig.HdCopy);
        await Task.Delay(20);
        await Page(rig, rig.Admin, rig.HdCopy);
        return rig;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AccessRevokedDuringTheArrReadsLeavesNoReadyAndNoJourney(bool parental)
    {
        using var rig = await WarmMovie();
        var before = Items(await Page(rig, rig.Member, rig.HdCopy))[0];
        Assert.Equal(StatusStage.Ready, before.GetProperty("stage").GetString());
        Assert.True(before.TryGetProperty("journey", out _));

        // Library access (or a parental limit the movie is above) is taken away while the answer is being prepared.
        DuringTheArrReads(rig.View, () => rig.View.Revoke(rig.Member, parental: parental ? true : null, hide: new[] { rig.HdCopy }));
        Assert.Empty(Items(await Page(rig, rig.Member, rig.HdCopy)));
        // The cards route too, and the key route has no Ready from the copy they can't open any more.
        var member = rig.View.Users[rig.Member.UserId];
        Assert.Empty(Items(Encoding(await rig.Service.ForBatchAsync(member, new[] { rig.HdCopy }, Array.Empty<TitleKey>(), default))));
    }

    [Fact]
    public async Task ACardsAnswerIsJudgedByTheViewerAfterTheArrReads()
    {
        using var rig = await WarmMovie();
        Assert.Single(Items(Encoding(await rig.Service.ForBatchAsync(rig.Member, new[] { rig.HdCopy }, Array.Empty<TitleKey>(), default))));
        DuringTheArrReads(rig.View, () => rig.View.Revoke(rig.Member, hide: new[] { rig.HdCopy }));
        Assert.Empty(Items(Encoding(await rig.Service.ForBatchAsync(rig.Member, new[] { rig.HdCopy }, Array.Empty<TitleKey>(), default))));
    }

    [Fact]
    public async Task AnAdministratorDemotedDuringTheArrReadsGetsNoAdminBlock()
    {
        using var rig = await WarmMovie();
        Assert.True(Items(await Page(rig, rig.Admin, rig.HdCopy))[0].TryGetProperty("admin", out _));

        DuringTheArrReads(rig.View, () => rig.View.Revoke(rig.Admin, admin: false));
        var page = Items(await Page(rig, rig.Admin, rig.HdCopy))[0];
        Assert.False(page.TryGetProperty("admin", out _));

        // The key detail route (the more-info modal), the Manage drawer's scope route and the notifications' current status too.
        var demoted = rig.View.Users[rig.Admin.UserId];
        var admin = rig.View.AddUser(admin: true, policy: "same");
        DuringTheArrReads(rig.View, () => rig.View.Revoke(admin, admin: false));
        Assert.False(Items(Encoding(await rig.Service.ForKeyDetailAsync(admin, Sintel, default)))[0].TryGetProperty("admin", out _));
        var other = rig.View.AddUser(admin: true, policy: "same");
        DuringTheArrReads(rig.View, () => rig.View.Revoke(other, admin: false));
        Assert.Null((await rig.Service.CurrentAsync(other, rig.HdCopy, null, default))?.Admin);
        Assert.False(demoted.IsAdmin);
    }

    [Fact]
    public async Task AnAbsentPageAndAScopeKeyAreJudgedByTheViewerAfterTheArrReads()
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false);
        var page = new AbsentTitle { PageId = Guid.NewGuid(), Kind = "series", Title = Firefly, TmdbId = 1437 };
        await rig.Service.ForAbsentAsync(rig.Admin, page, default);
        await Task.Delay(20);
        Assert.True(Items(Encoding(await rig.Service.ForAbsentAsync(rig.Admin, page, default)))[0].TryGetProperty("admin", out _));
        DuringTheArrReads(rig.View, () => rig.View.Revoke(rig.Admin, admin: false));
        foreach (var status in Items(Encoding(await rig.Service.ForAbsentAsync(rig.Admin, page, default)))) Assert.False(status.TryGetProperty("admin", out _));

        var admin = rig.View.AddUser(admin: true, policy: "same");
        Assert.True(Items(Encoding(await rig.Service.ForScopeKeyAsync(admin, Firefly.WithEpisode(1, 9), default)))[0].TryGetProperty("admin", out _));
        DuringTheArrReads(rig.View, () => rig.View.Revoke(admin, admin: false));
        foreach (var status in Items(Encoding(await rig.Service.ForScopeKeyAsync(admin, Firefly.WithEpisode(1, 9), default)))) Assert.False(status.TryGetProperty("admin", out _));
    }

    [Fact]
    public async Task ARequesterWhoLostAccessDuringTheCheckIsNotFulfilledAndTheirPageHasNoReady()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        await lab.Warm();
        var standard = await lab.Ask(lab.Emma, new MutationInput { Key = Matrix });
        await lab.Outbox.TickAsync(default);
        var copy = Guid.NewGuid();
        lab.View.AddCopy(TitleKey.Parse(Matrix)!, new JfCopy { ItemId = copy, Path = "/media/movies/The Matrix (1999)/The Matrix.mkv", LibraryName = "Movies", DateCreated = lab.Arr.Now.UtcDateTime });
        lab.View.Rev++;

        // Emma loses access to Movies while the check reads the arrs.
        DuringTheArrReads(lab.View, () => lab.View.Revoke(lab.Emma, hide: new[] { copy }));
        Assert.Equal(0, await lab.Fulfilment.CheckAsync(new[] { Matrix }, default));
        Assert.NotEqual("fulfilled", lab.Ledger.Find(standard)!.Status);

        // Her Requests page, prepared before the change, composes for her as she is after it.
        var revoked = lab.View.Users[lab.Emma.UserId];
        Assert.NotEqual(lab.Emma.PolicyRevision, revoked.PolicyRevision);
        lab.View.Users[lab.Emma.UserId] = lab.Emma;
        DuringTheArrReads(lab.View, () => lab.View.Users[lab.Emma.UserId] = revoked);
        Assert.NotEqual("ready", (await lab.Page(lab.Emma))[Matrix].GetProperty("group").GetString());
    }

    [Fact]
    public async Task SeasonRowsAreJudgedByTheViewerAfterTheMetadataRead()
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        var series = Guid.NewGuid();
        var season = Guid.NewGuid();
        r.View.AddItem(new JfItemRef { ItemId = season, Kind = "season", Key = Firefly.WithSeason(1), SeriesId = series, Season = 1, TmdbId = 1437 });
        r.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1 });
        var revoke = false;
        var rows = new SeasonRowsService(r.View, r.Ledger, r.Policy, null, (_, _, _, _) =>
        {
            if (revoke) r.View.Revoke(r.View.Users[r.Member], parental: true, hide: new[] { season });
            return Task.FromResult<string?>("{\"episodes\":[{\"episode_number\":1,\"name\":\"Serenity\"},{\"episode_number\":2,\"name\":\"The Train Job\"}]}");
        }, () => r.Now);
        Assert.NotNull(await rows.ForSeasonAsync(r.View.Users[r.Member], season, "en", default));
        revoke = true;
        Assert.Null(await rows.ForSeasonAsync(r.View.Users[r.Member], season, "en", default));
    }

    [Fact]
    public async Task AFamilySearchIsJudgedByTheViewerAfterTheArrReads()
    {
        // Firefly: Jellyfin has the 4K folder's S1E1-E2 only; the standard Sonarr has been looking for them since 2002.
        using var rig = new Rig(Layout.SeparateLibraries, Has.Uhd, movie: false);
        await rig.Service.SearchableEpisodesAsync(rig.Member, Firefly, 5, null, default);
        await Task.Delay(20);
        var control = rig.View.AddUser(admin: false, policy: "same");
        Assert.NotEmpty(await rig.Service.SearchableEpisodesAsync(control, Firefly, 5, null, default));
        // The member loses both libraries while the arrs are read: nothing to search for them.
        DuringTheArrReads(rig.View, () => rig.View.Revoke(rig.Member, hide: new[] { rig.HdCopy, rig.UhdCopy }));
        Assert.Empty(await rig.Service.SearchableEpisodesAsync(rig.Member, Firefly, 5, null, default));
    }

    // ------------------------------------------------------------------ B1: a standard whole series honours the switch

    [Theory]
    [InlineData(Layout.OneItem)]
    [InlineData(Layout.SeparateLibraries)]
    [InlineData(Layout.GroupedFolders)]
    public async Task AStandardWholeSeriesRequestNeedsANon4kEpisodeWithTheSwitchOn(Layout layout)
    {
        // A Seerr standard request with no seasons (the whole series). Jellyfin has only 2160p episodes.
        using var rig = new Rig(layout, Has.Uhd, movie: false);
        var scope = new ArrStatusService.RequestScope(Array.Empty<int>(), false, null);
        Assert.Equal(StatusStage.Ready, (await Whole(rig, scope)).Status.Stage);
        rig.Arr.Plugin.Plugin.Configuration.ArrStandardNeedsNonFourK = true;
        var held = await Whole(rig, scope);
        Assert.NotEqual(StatusStage.Ready, held.Status.Stage);
        Assert.Null(held.ArrivedAt);

        // With 1080p episodes of every monitored season too: Ready, Play on them.
        foreach (var e in new[] { 1, 2 }) rig.View.AddEpisodeFile(rig.HdCopy, Firefly, 1, e, 1920, 1080, rig.Now);
        var both = await Whole(rig, scope);
        Assert.Equal((StatusStage.Ready, (Guid?)rig.HdCopy), (both.Status.Stage, both.Visible?.ItemId));
    }

    private static async Task<ArrStatusService.KeyedStatus> Whole(Rig rig, ArrStatusService.RequestScope scope)
    {
        var scopes = new Dictionary<TitleKey, ArrStatusService.RequestScope> { [Firefly] = scope };
        await rig.Service.ComposeForAsync(rig.Member, new[] { Firefly }, scopes, default, loadEpisodes: true);
        await Task.Delay(20);
        return Assert.Single(await rig.Service.ComposeForAsync(rig.Member, new[] { Firefly }, scopes, default, loadEpisodes: true));
    }

    // ------------------------------------------------------------------ B2: a placeholder or missing movie is never Ready

    [Fact]
    public async Task AMissingMovieCopyIsNoStandardArrivalEvenWithTheSwitchOff()
    {
        using var rig = new Rig(Layout.OneItem, Has.Hd, movie: true);
        // Jellyfin's only copy has no file (a missing, virtual item), whatever Radarr says.
        rig.View.Items.Remove(rig.HdCopy);
        rig.View.SourcesByItem.Remove(rig.HdCopy);
        rig.View.AddItem(new JfItemRef { ItemId = rig.HdCopy, Kind = "movie", Key = Sintel, Virtual = true });
        rig.View.Rev++;
        var standard = await rig.Requested(Part.Movie, fourK: false);
        Assert.NotEqual(StatusStage.Ready, standard.Status.Stage);
        Assert.Null(standard.ArrivedAt);

        // Once the file is there: Ready as before (the whole title).
        rig.View.Items.Remove(rig.HdCopy);
        rig.MovieCopy(Guid.NewGuid(), "/media/movies/Sintel (2010)/Sintel.mkv", "Movies", (1920, 1080));
        Assert.Equal(StatusStage.Ready, (await rig.Requested(Part.Movie, fourK: false)).Status.Stage);
    }

    [Fact]
    public async Task AMissingMovieCopyNeverFulfilsTheLedgersStandardRequest()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        await lab.Warm();
        var standard = await lab.Ask(lab.Emma, new MutationInput { Key = Matrix });
        await lab.Outbox.TickAsync(default);
        var copy = Guid.NewGuid();
        lab.View.AddItem(new JfItemRef { ItemId = copy, Kind = "movie", Key = TitleKey.Parse(Matrix), Virtual = true });
        lab.View.AddCopy(TitleKey.Parse(Matrix)!, new JfCopy { ItemId = copy, LibraryName = "Movies", DateCreated = lab.Arr.Now.UtcDateTime });
        lab.View.Rev++;
        Assert.Equal(0, await lab.Fulfilment.CheckAsync(new[] { Matrix }, default));
        Assert.NotEqual("fulfilled", lab.Ledger.Find(standard)!.Status);
        Assert.NotEqual("ready", (await lab.Page(lab.Emma))[Matrix].GetProperty("group").GetString());
    }

    // ------------------------------------------------------------------ helpers

    private static async Task<string> Page(Rig rig, StatusViewer viewer, Guid id)
        => Encoding(await rig.Service.ForItemAsync(viewer, id, default));

    private static async Task<string> Page(IntegrationRequestArrivalsTests.Lab lab, StatusViewer viewer, Guid id)
        => Encoding(await lab.Status.ForItemAsync(viewer, id, default));

    private static string Encoding(StatusBody body) => System.Text.Encoding.UTF8.GetString(body.Json);

    private static List<JsonElement> Items(string body)
    {
        using var doc = JsonDocument.Parse(body);
        return doc.RootElement.GetProperty("items").EnumerateArray().Select(e => e.Clone()).ToList();
    }
}
