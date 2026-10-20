using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Collages;
using V = Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Collages.ListCollageArtworkVerdict;
using S = Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Collages.ListCollagePosterReadState;

namespace JE.Tests;

// Which posters one viewer's list collage may use: the list's own order, only posters the server verified for exactly
// that title, nothing the viewer hid or guards (admins included), and fail-closed on anything unknown. The fixtures are
// plain inputs; they stand for what the list/privacy owners will supply, not for those owners.
public class ListsCollagePosterSetTests
{
    private static readonly Guid A = Guid.Parse("aaaaaaaa-0000-0000-0000-000000000001");
    private static readonly Guid B = Guid.Parse("bbbbbbbb-0000-0000-0000-000000000002");

    // ---- order ------------------------------------------------------------------------------------------------------

    [Fact]
    public void APlaylistFollowsItsCanonicalOrderThenUnorderedEntriesInDocumentOrder()
    {
        var items = new[] { Movie("a", 1), Movie("b", 2), Movie("c", 3), Movie("d", 4), Movie("e", 5) };
        var order = new[] { "p:c", "e:" + Guid.NewGuid().ToString("N") + ":0", "p:a", "p:missing" };
        var selection = Select(ListKinds.Playlist, items, order, Verified(items), Viewer(A, items));

        Assert.Equal(ListCollageSelectionStatus.Selected, selection.Status);
        Assert.Equal(new[] { "c", "a", "b", "d", "e" }, selection.Candidates.Select(c => c.PlaceholderId));
        Assert.Equal(new[] { "/c.jpg", "/a.jpg", "/b.jpg", "/d.jpg", "/e.jpg" }, selection.Candidates.Select(c => c.PosterPath));
    }

    [Fact]
    public void ACollectionIsInReleaseOrderWithTbaLastAndTiesByTitleThenId()
    {
        var items = new[]
        {
            Movie("tba", 1, date: null, title: "Zeta"),
            Movie("late", 2, date: "2021-05-01"),
            Movie("tie-b", 3, date: "2010-01-01", title: "beta"),
            Movie("tie-a", 4, date: "2010-01-01", title: "Alpha"),
            Movie("early", 5, date: "1999-12-31"),
            Movie("tie-a2", 6, date: "2010-01-01", title: "alpha"),
        };

        // Stored order is ignored for a collection.
        var selection = Select(ListKinds.Collection, items, new[] { "p:tba", "p:late" }, Verified(items), Viewer(A, items));

        Assert.Equal(new[] { "early", "tie-a", "tie-a2", "tie-b", "late", "tba" }, selection.Candidates.Select(c => c.PlaceholderId));
    }

    [Fact]
    public void AtMostEightDistinctPostersAreAcceptedAfterAtMost48Checks()
    {
        var many = Enumerable.Range(0, 20).Select(i => Movie("m" + i, 100 + i)).ToArray();
        var full = Select(ListKinds.Playlist, many, Order(many), Verified(many), Viewer(A, many));
        Assert.Equal(8, full.Candidates.Count);
        Assert.Equal(8, full.Checked);
        Assert.Equal(many.Take(8).Select(m => m.Id), full.Candidates.Select(c => c.PlaceholderId));

        // 45 hidden titles first: the 48-check budget stops after three accepted ones.
        var mostlyHidden = Enumerable.Range(0, 60).Select(i => Movie("h" + i, 200 + i)).ToArray();
        var verdicts = mostlyHidden.ToDictionary(m => m.Id, m => int.Parse(m.Id[1..]) < 45 ? V.Hidden : V.Allowed);
        var bounded = Select(ListKinds.Playlist, mostlyHidden, Order(mostlyHidden), Verified(mostlyHidden), new ListCollageViewer(A, true, "rev-1", verdicts));
        Assert.Equal(48, bounded.Checked);
        Assert.Equal(new[] { "h45", "h46", "h47" }, bounded.Candidates.Select(c => c.PlaceholderId));
        Assert.Equal(48, ListCollagePosterSet.MaxChecks);
        Assert.Equal(8, ListCollagePosterSet.MaxCandidates);

        // Two titles with the same server poster count once.
        var dupes = new[] { Movie("x", 1), Movie("y", 2), Movie("z", 3) };
        var evidence = new[] { Ev(dupes[0], S.Verified, "/same.jpg"), Ev(dupes[1], S.Verified, "/same.jpg"), Ev(dupes[2], S.Verified, "/z.jpg") };
        var distinct = Select(ListKinds.Playlist, dupes, Order(dupes), evidence, Viewer(A, dupes));
        Assert.Equal(new[] { "/same.jpg", "/z.jpg" }, distinct.Candidates.Select(c => c.PosterPath));
    }

    // ---- poster authority -------------------------------------------------------------------------------------------

    [Fact]
    public void OnlyAServerVerifiedPosterForExactlyThatTitleIsAuthority()
    {
        var ok = Movie("ok", 1, poster: "/client.jpg");
        var custom = new Placeholder { Id = "custom", Kind = PlaceholderKinds.Custom, MediaType = "movie", Title = "Fan edit", PosterPath = "/mine.jpg" };
        var noId = new Placeholder { Id = "noid", Kind = PlaceholderKinds.Movie, MediaType = "movie", Title = "No id", PosterPath = "/noid.jpg" };
        var clientOnly = Movie("client", 3, poster: "/client3.jpg");
        var otherTitle = Movie("other", 4);
        var otherKind = Movie("kind", 5);
        var season = Season("season", 6, 2);
        var badPath = Movie("bad", 7);
        var partial = Movie("partial", 8);
        var unavailable = Movie("unavail", 9);
        var noEvidence = Movie("noev", 10);
        var twice = Movie("twice", 11);
        var items = new[] { custom, noId, clientOnly, otherTitle, otherKind, season, badPath, partial, unavailable, noEvidence, twice, ok };
        var evidence = new List<ListCollagePosterEvidence>
        {
            new("custom", PlaceholderKinds.Custom, null, null, S.Verified, "/mine.jpg"),
            new("noid", PlaceholderKinds.Movie, null, null, S.Verified, "/noid.jpg"),
            Ev(clientOnly, S.NotVerified, "/client3.jpg"),
            new("other", PlaceholderKinds.Movie, 999, null, S.Verified, "/other.jpg"),       // another title's read
            new("kind", PlaceholderKinds.Series, 5, null, S.Verified, "/kind.jpg"),          // the series, not the movie
            new("season", PlaceholderKinds.Season, 6, 3, S.Verified, "/season3.jpg"),       // another season
            Ev(badPath, S.Verified, "../etc/passwd.jpg"),
            Ev(partial, S.Partial, "/partial.jpg"),
            Ev(unavailable, S.Unavailable, "/unavail.jpg"),
            Ev(twice, S.Verified, "/twice-1.jpg"),
            Ev(twice, S.Verified, "/twice-2.jpg"),                                           // ambiguous
            Ev(ok, S.Verified, "/server.jpg"),
        };

        var selection = Select(ListKinds.Playlist, items, Order(items), evidence, Viewer(A, items));

        Assert.Equal(new[] { ("ok", "/server.jpg") }, selection.Candidates.Select(c => (c.PlaceholderId, c.PosterPath)));
        Assert.True(selection.RetryWanted); // partial/unavailable/unverified/missing reads may answer later
    }

    [Fact]
    public void AKnownNoPosterIsFinalButAFailedReadIsRetriedAndNeverAnsweredWithTheShowsPoster()
    {
        var none = Movie("none", 1);
        var failedSeason = Season("s2", 300, 2);
        var answeredSeason = Season("s1", 300, 1);
        var items = new[] { none, failedSeason, answeredSeason };

        var final = Select(ListKinds.Playlist, new[] { none }, Order(new[] { none }), new[] { Ev(none, S.KnownNoPoster, null) }, Viewer(A, items));
        Assert.Equal(ListCollageSelectionStatus.Empty, final.Status);
        Assert.False(final.RetryWanted);

        // The failed season read carries the show's poster: it is not used in the season's place.
        var evidence = new[]
        {
            Ev(none, S.KnownNoPoster, null),
            Ev(failedSeason, S.ReadFailed, "/show.jpg"),
            Ev(answeredSeason, S.Verified, "/season1.jpg"),
        };
        var selection = Select(ListKinds.Playlist, items, Order(items), evidence, Viewer(A, items));
        Assert.Equal(new[] { "/season1.jpg" }, selection.Candidates.Select(c => c.PosterPath));
        Assert.True(selection.RetryWanted);
    }

    [Fact]
    public void TheBaseMetadataSeamMapsToTypedEvidence()
    {
        var today = new DateTime(2026, 10, 20, 0, 0, 0, DateTimeKind.Utc);
        var movie = Movie("m", 10, poster: "/client.jpg");
        var season = Season("s", 20, 2);

        Assert.Equal(S.Unavailable, ListCollagePosterEvidence.FromMetadata(movie, null).State);
        var verified = ListCollagePosterEvidence.FromMetadata(movie, new PlaceholderMetadata { FetchedAtUtc = today, PosterPath = "/server.jpg" });
        Assert.Equal((S.Verified, "/server.jpg", 10, (int?)null, PlaceholderKinds.Movie), (verified.State, verified.ServerPosterPath, verified.TmdbId, verified.SeasonNumber, verified.Kind));
        Assert.Equal(S.KnownNoPoster, ListCollagePosterEvidence.FromMetadata(movie, new PlaceholderMetadata { FetchedAtUtc = today }).State);
        Assert.Equal(S.KnownNoPoster, ListCollagePosterEvidence.FromMetadata(movie, new PlaceholderMetadata { FetchedAtUtc = today, PosterPath = "not a path" }).State);
        Assert.Equal(S.Partial, ListCollagePosterEvidence.FromMetadata(season, new PlaceholderMetadata { FetchedAtUtc = today, PosterPath = "/show.jpg", Partial = true }).State);
        Assert.Equal(S.ReadFailed, ListCollagePosterEvidence.FromMetadata(season, new PlaceholderMetadata { FetchedAtUtc = today, PosterPath = "/show.jpg", Partial = true, SeasonReadFailed = true }).State);
        Assert.Equal((2, 20), (ListCollagePosterEvidence.FromMetadata(season, null).SeasonNumber, ListCollagePosterEvidence.FromMetadata(season, null).TmdbId));

        // The TMDB read JE uses without Seerr: answered with or without a poster, or no answer.
        Assert.Equal((S.Verified, "/t.jpg"), Pair(ListCollagePosterEvidence.FromTmdbRead(movie, "/t.jpg", answered: true)));
        Assert.Equal(S.KnownNoPoster, ListCollagePosterEvidence.FromTmdbRead(movie, null, answered: true).State);
        Assert.Equal(S.ReadFailed, ListCollagePosterEvidence.FromTmdbRead(movie, null, answered: false).State);
        Assert.Equal(S.ReadFailed, ListCollagePosterEvidence.FromTmdbRead(movie, "/t.jpg", answered: false).State);

        // A custom entry or one without a TMDB id has no server poster, whatever the client stored.
        var custom = new Placeholder { Id = "c", Kind = PlaceholderKinds.Custom, PosterPath = "/mine.jpg" };
        Assert.Equal(S.NotVerified, ListCollagePosterEvidence.FromMetadata(custom, new PlaceholderMetadata { FetchedAtUtc = today, PosterPath = "/mine.jpg" }).State);

        static (S, string?) Pair(ListCollagePosterEvidence e) => (e.State, e.ServerPosterPath);
    }

    [Fact]
    public void PostersWhoseBytesFailedForGoodAreSkippedForTheNextOnes()
    {
        var items = new[] { Movie("a", 1), Movie("b", 2), Movie("c", 3) };
        var selection = Select(ListKinds.Playlist, items, Order(items), Verified(items), Viewer(A, items), skip: new[] { "/a.jpg" });
        Assert.Equal(new[] { "/b.jpg", "/c.jpg" }, selection.Candidates.Select(c => c.PosterPath));
    }

    // ---- one viewer -------------------------------------------------------------------------------------------------

    [Fact]
    public void HiddenGuardedAndDeniedArtworkIsLeftOutEvenForAnAdmin()
    {
        var items = new[] { Movie("hidden", 1), Movie("guarded", 2), Movie("collection", 3), Movie("pending", 4), Movie("unknown", 5), Movie("missing", 6), Movie("ok", 7) };
        var verdicts = new Dictionary<string, ListCollageArtworkVerdict>
        {
            ["hidden"] = V.Hidden,
            ["guarded"] = V.Guarded,
            ["collection"] = V.CollectionArtworkDenied,
            ["pending"] = V.PendingTmdbArtworkDenied,
            ["unknown"] = V.Unknown,
            ["ok"] = V.Allowed,
        };

        // An unrestricted administrator's own Hidden Content and Spoiler Guard rules still apply: there is no admin path.
        var admin = new ListCollageViewer(A, true, "admin-rev", verdicts);
        var selection = Select(ListKinds.Playlist, items, Order(items), Verified(items), admin);

        Assert.Equal(new[] { "ok" }, selection.Candidates.Select(c => c.PlaceholderId));
        Assert.True(selection.RetryWanted); // the unknown and missing verdicts may resolve later
    }

    [Fact]
    public void AnUnknownViewerOrPolicyGetsNoPosterSet()
    {
        var items = new[] { Movie("a", 1) };
        var allowed = new Dictionary<string, ListCollageArtworkVerdict> { ["a"] = V.Allowed };

        foreach (var viewer in new[]
                 {
                     new ListCollageViewer(Guid.Empty, true, "rev", allowed),  // no user
                     new ListCollageViewer(A, false, "rev", allowed),          // an API key or device, not a person
                     new ListCollageViewer(A, true, null, allowed),            // policy could not be read
                     new ListCollageViewer(A, true, " ", allowed),
                 })
        {
            var selection = Select(ListKinds.Playlist, items, Order(items), Verified(items), viewer);
            Assert.Equal(ListCollageSelectionStatus.ViewerUnknown, selection.Status);
            Assert.Empty(selection.Candidates);
            Assert.Equal(string.Empty, selection.SafeSetDigest);
        }

        var unsupported = Select("folder", items, Order(items), Verified(items), Viewer(A, items));
        Assert.Equal(ListCollageSelectionStatus.Unsupported, unsupported.Status);
        Assert.Empty(unsupported.Candidates);
    }

    [Fact]
    public void EachViewerGetsTheirOwnSafeSetFromTheSameList()
    {
        var items = new[] { Movie("p1", 1), Movie("p2", 2), Movie("p3", 3), Movie("p4", 4), Movie("p5", 5) };
        var evidence = Verified(items);
        var forA = Select(ListKinds.Playlist, items, Order(items), evidence, Viewer(A, items));
        var bVerdicts = items.ToDictionary(i => i.Id, _ => V.Allowed);
        bVerdicts["p1"] = V.Hidden;
        bVerdicts["p3"] = V.Guarded;
        var forB = Select(ListKinds.Playlist, items, Order(items), evidence, new ListCollageViewer(B, true, "b-rev", bVerdicts));

        Assert.Equal(new[] { "p1", "p2", "p3", "p4", "p5" }, forA.Candidates.Select(c => c.PlaceholderId));
        Assert.Equal(new[] { "p2", "p4", "p5" }, forB.Candidates.Select(c => c.PlaceholderId));
        Assert.Equal((A, "rev-" + A.ToString("N")[..4]), (forA.Viewer, forA.PolicyRevision));
        Assert.Equal((B, "b-rev"), (forB.Viewer, forB.PolicyRevision));
        Assert.NotEqual(forA.SafeSetDigest, forB.SafeSetDigest);

        // The selection only ever sees one viewer: there is no audience, roster or cap to pass.
        Assert.All(typeof(ListCollageSelectionInput).GetProperties(), p => Assert.DoesNotContain("Viewers", p.Name, StringComparison.Ordinal));
        Assert.DoesNotContain(typeof(ListCollageSelectionInput).GetProperties(), p => p.PropertyType.IsAssignableTo(typeof(System.Collections.IEnumerable)) && p.PropertyType.IsGenericType && p.PropertyType.GetGenericArguments().Contains(typeof(ListCollageViewer)));
    }

    [Fact]
    public void SelectionIsDeterministicAndIgnoresEvidenceOrder()
    {
        var items = new[] { Movie("a", 1), Movie("b", 2), Movie("c", 3) };
        var evidence = Verified(items);
        var first = Select(ListKinds.Collection, items, Order(items), evidence, Viewer(A, items));
        var second = Select(ListKinds.Collection, items, Order(items), Enumerable.Reverse(evidence).ToList(), Viewer(A, items));
        Assert.Equal(first.Candidates, second.Candidates);
        Assert.Equal(first.SafeSetDigest, second.SafeSetDigest);
        Assert.Matches("^[0-9a-f]{64}$", first.SafeSetDigest);
    }

    // ---- byte identity vs grant identity ------------------------------------------------------------------------------

    [Fact]
    public void TheByteKeyIsTheExactOrderedContentShapeRendererAndTransformOnly()
    {
        var one = new byte[] { 1, 2, 3 };
        var two = new byte[] { 4, 5, 6 };
        var key = ListCollageByteKey.Compute(ListCollageShape.Square, new[] { one, two }, "original");

        Assert.Equal(key, ListCollageByteKey.Compute(ListCollageShape.Square, new[] { (byte[])one.Clone(), (byte[])two.Clone() }, "original"));
        Assert.NotEqual(key, ListCollageByteKey.Compute(ListCollageShape.Square, new[] { two, one }, "original"));
        Assert.NotEqual(key, ListCollageByteKey.Compute(ListCollageShape.Poster, new[] { one, two }, "original"));
        Assert.NotEqual(key, ListCollageByteKey.Compute(ListCollageShape.Square, new[] { one, two }, "w=300"));
        Assert.NotEqual(key, ListCollageByteKey.Compute(ListCollageShape.Square, new[] { one, new byte[] { 4, 5, 7 } }, "original"));
        Assert.NotEqual(key, ListCollageByteKey.Compute(ListCollageShape.Square, new[] { one }, "original"));
        Assert.Matches("^[0-9a-f]{64}$", key.Value);
        Assert.Contains(ListCollageRenderer.Version, ListCollageByteKey.Canonical(ListCollageShape.Square, new[] { one }, "original"), StringComparison.Ordinal);

        // No viewer, list or permission can be part of it.
        Assert.Equal(new[] { "Value" }, typeof(ListCollageByteKey).GetProperties().Select(p => p.Name));
        Assert.Throws<ArgumentException>(() => ListCollageByteKey.Compute(ListCollageShape.Square, Array.Empty<byte[]>(), "original"));
        Assert.Throws<ArgumentException>(() => ListCollageByteKey.Compute(ListCollageShape.Square, new[] { one }, "has space"));
        Assert.Throws<ArgumentException>(() => ListCollageByteKey.Compute(ListCollageShape.Square, Enumerable.Repeat(one, 5).ToList(), "original"));
    }

    [Fact]
    public void TwoViewersWithTheSameBytesStillGetDifferentGrants()
    {
        var items = new[] { Movie("a", 1), Movie("b", 2) };
        var forA = Select(ListKinds.Playlist, items, Order(items), Verified(items), Viewer(A, items));
        var forB = Select(ListKinds.Playlist, items, Order(items), Verified(items), new ListCollageViewer(B, true, "rev-b", items.ToDictionary(i => i.Id, _ => V.Allowed)));
        Assert.Equal(forA.SafeSetDigest, forB.SafeSetDigest); // same safe posters, so the same bytes may be reused...

        var grantA = Grant(A, forA);
        var grantB = Grant(B, forB);
        Assert.NotEqual(grantA.Digest(), grantB.Digest()); // ...under separate permission
        Assert.NotEqual(grantA.Digest(), (grantA with { Viewer = B }).Digest()); // even with every other input equal

        // Every authority input changes the grant.
        foreach (var changed in new[]
                 {
                     grantA with { ServerId = "other-server" },
                     grantA with { ListId = Guid.NewGuid() },
                     grantA with { ListIncarnation = "inc-2" },
                     grantA with { PolicyRevision = "rev-2" },
                     grantA with { SettingsRevision = "settings-2" },
                     grantA with { ConsentRevision = "consent-2" },
                     grantA with { MembershipRevision = "members-2" },
                     grantA with { RestoreGeneration = "restore-2" },
                     grantA with { SafeSetDigest = new string('0', 64) },
                     grantA with { GrantVersion = 2 },
                 })
        {
            Assert.NotEqual(grantA.Digest(), changed.Digest());
        }

        // A missing authority input is no grant.
        foreach (var incomplete in new[] { grantA with { ServerId = "" }, grantA with { Viewer = Guid.Empty }, grantA with { ListId = Guid.Empty }, grantA with { RestoreGeneration = " " }, grantA with { SafeSetDigest = "" }, grantA with { GrantVersion = 0 } })
        {
            Assert.Throws<InvalidOperationException>(() => incomplete.Digest());
        }
    }

    // ---- fixtures ---------------------------------------------------------------------------------------------------

    private static ListCollageSelection Select(string kind, IReadOnlyList<Placeholder> items, IReadOnlyList<string> order, IReadOnlyList<ListCollagePosterEvidence> evidence, ListCollageViewer viewer, IReadOnlyCollection<string>? skip = null) =>
        ListCollagePosterSet.Select(new ListCollageSelectionInput(kind, items, order, evidence, viewer, skip));

    private static Placeholder Movie(string id, int tmdb, string? date = "2020-01-01", string? title = null, string? poster = null) =>
        new() { Id = id, Kind = PlaceholderKinds.Movie, MediaType = "movie", TmdbId = tmdb, Title = title ?? id, ReleaseDate = date, PosterPath = poster };

    private static Placeholder Season(string id, int tmdb, int number) =>
        new() { Id = id, Kind = PlaceholderKinds.Season, MediaType = "tv", TmdbId = tmdb, SeasonNumber = number, Title = "Show S" + number };

    private static ListCollagePosterEvidence Ev(Placeholder p, ListCollagePosterReadState state, string? path) =>
        new(p.Id, p.Kind, p.TmdbId, p.SeasonNumber, state, path);

    private static List<ListCollagePosterEvidence> Verified(IEnumerable<Placeholder> items) =>
        items.Select(p => Ev(p, S.Verified, "/" + p.Id + ".jpg")).ToList();

    private static string[] Order(IEnumerable<Placeholder> items) => items.Select(p => ListOrder.PlaceholderToken(p.Id)).ToArray();

    private static ListCollageViewer Viewer(Guid user, IEnumerable<Placeholder> items) =>
        new(user, true, "rev-" + user.ToString("N")[..4], items.ToDictionary(i => i.Id, _ => V.Allowed));

    private static ListCollageGrantIdentity Grant(Guid viewer, ListCollageSelection selection) =>
        new("server-1", Guid.Parse("11111111-2222-3333-4444-555555555555"), "inc-1", viewer, selection.PolicyRevision, "settings-1", "consent-1", "members-1", "restore-1", selection.SafeSetDigest, 1);
}
