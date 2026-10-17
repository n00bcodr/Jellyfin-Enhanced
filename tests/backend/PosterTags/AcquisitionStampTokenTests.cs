using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Moq;

namespace JE.Tests;

/// <summary>
/// Phase 4e through the real poster data provider and variant tokens: each viewer's stamp is pinned in their own token's
/// data hash; a viewer without a stamp (or who opted out) keeps the exact pre-4e hash; watching, an upgrade and expiry
/// move the hash because they move the resolved stamp.
/// </summary>
[Collection("Plugin singleton")]
public class AcquisitionStampTokenTests
{
    private static readonly DateTime T0 = StampWorld.T0;

    private sealed class Movie : MediaBrowser.Controller.Entities.Movies.Movie
    {
        public List<MediaSourceInfo> Sources { get; init; } = [];

        public override List<MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => Sources;
    }

    private sealed class Rig : IDisposable
    {
        public ApiPluginFixture F { get; } = new();
        public StampWorld W { get; } = new();
        public TagCacheService Cache { get; }
        public PosterTagDataProvider Provider { get; }
        public PosterTagVariantToken Tokens { get; }
        public Guid MovieId { get; } = Guid.NewGuid();

        public Rig()
        {
            F.Plugin.Configuration.TagCacheServerMode = true;
            F.Plugin.Configuration.ShowUserReviews = false;
            W.Config = StampWorld.On(native: true);
            var movie = new Movie
            {
                Id = MovieId, Name = "The Matrix", Genres = ["Science Fiction"], CommunityRating = 8.7f, OfficialRating = "R",
                Sources = [new() { MediaStreams = [new() { Type = MediaStreamType.Audio, Language = "eng" }, new() { Type = MediaStreamType.Video, Height = 1080, Codec = "h264" }] }],
            };
            var all = new BaseItem[] { movie };
            var library = new Mock<ILibraryManager>();
            library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns(all.Select(i => i.Id).ToArray());
            library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(all.ToArray());
            library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => all.SingleOrDefault(i => i.Id == id));
            library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => all.SingleOrDefault(i => i.Id == id));
            Cache = new TagCacheService(library.Object, F.Core.Paths.Object, Mock.Of<ILocalizationManager>(), F.Core.Logger);
            Cache.BuildFullCache(null, CancellationToken.None);
            Assert.True(Cache.TryGetEntry(MovieId, out _));
            var reviews = new PosterTagReviewRatings(F.Core.Manager, new PosterTagUserCache(Mock.Of<IUserManager>()), F.Core.Logger);
            // The Spoiler Guard parts are only used when drawing, never when pinning a hash.
            Provider = new PosterTagDataProvider(Cache, library.Object, null!, null!, reviews, W.Resolver, F.Core.Logger);
            Tokens = PosterTagVariantToken.CreateForPath(Path.Combine(F.Core.Root, "poster-secret"), _ => { });
        }

        public StampItem Item => W.Library.Items[MovieId];

        public string Plain()
        {
            Assert.True(Cache.TryGetEntry(MovieId, out var entry));
            return AcquisitionStampPosterTests.PreFourEHash(entry, PosterTagReviewSummary.None);
        }

        public PosterTagSettings Settings(string json) => PosterTagSettings.FromSettingsJson(json, W.Config);

        public void Dispose()
        {
            Provider.Dispose();
            Cache.Dispose();
            W.Dispose();
            F.Dispose();
        }
    }

    private static User Viewer(Guid id) => new("viewer-" + id.ToString("N")[..6], "default", "default") { Id = id };

    [Fact]
    public void TwoViewersOfTheSameItemGetDifferentTokensAndTheOptedOutOneKeepsThePlainHash()
    {
        using var rig = new Rig();
        var w = rig.W;
        w.AddMovie(StampWorld.Movie(603), T0.AddDays(-40), id: rig.MovieId);
        w.AddMovie(StampWorld.Movie(603), T0.AddDays(-30), fourK: true);    // both can open a 4K copy
        var (a, b) = (Viewer(Guid.NewGuid()), Viewer(Guid.NewGuid()));
        w.Store.AddNew(a.Id, rig.Item, T0, "request");
        w.Now = T0.AddHours(1);
        var settingsA = rig.Settings("{}");
        var settingsB = rig.Settings("{nativeAcquisitionStamps:false}");

        var snapA = rig.Provider.GetPinnedSnapshot(rig.MovieId, a, settingsA)!;
        var snapB = rig.Provider.GetPinnedSnapshot(rig.MovieId, b, settingsB)!;
        Assert.Equal(AcquisitionStamp.NewForYou, snapA.Stamp);
        Assert.Equal(AcquisitionStamp.None, snapB.Stamp);
        Assert.Equal(AcquisitionStamp.FourK, w.Resolver.Resolve(rig.MovieId, b.Id));     // it's B's choice that hides it
        Assert.Equal(rig.Plain(), snapB.PinnedHash);
        Assert.NotEqual(rig.Plain(), snapA.PinnedHash);
        Assert.Equal(rig.Plain(), rig.Provider.GetPinnedDataHash(rig.MovieId, b, settingsB));
        Assert.Equal(rig.Plain(), rig.Provider.GetPinnedDataHash(rig.MovieId, a));          // no settings: no stamp, the old call

        var tokenA = rig.Tokens.Mint(a.Id, rig.MovieId, settingsA.Digest, "r1", PosterTagVariantFlags.None, snapA.PinnedHash);
        var tokenB = rig.Tokens.Mint(b.Id, rig.MovieId, settingsB.Digest, "r1", PosterTagVariantFlags.None, snapB.PinnedHash);
        Assert.True(PosterTagVariantToken.TryParse(tokenA, out var parsedA));
        Assert.True(PosterTagVariantToken.TryParse(tokenB, out var parsedB));
        Assert.NotEqual(parsedA.DataHash, parsedB.DataHash);
        Assert.NotEqual(parsedA.Mac, parsedB.Mac);
        Assert.Equal(rig.Plain(), parsedB.DataHash);
        Assert.True(rig.Tokens.Verify(tokenA, a.Id, rig.MovieId, settingsA.Digest, "r1", out _));
        Assert.False(rig.Tokens.Verify(tokenA, b.Id, rig.MovieId, settingsA.Digest, "r1", out _));     // A's stamped poster isn't B's

        // B with stamps on would pin their 4K stamp instead.
        var fourK = rig.Provider.GetPinnedSnapshot(rig.MovieId, b, rig.Settings("{}"))!;
        Assert.Equal(AcquisitionStamp.FourK, fourK.Stamp);
        Assert.NotEqual(rig.Plain(), fourK.PinnedHash);
        Assert.NotEqual(snapA.PinnedHash, fourK.PinnedHash);
    }

    [Fact]
    public void WatchingAnUpgradeAndExpiryMoveThePinnedHash()
    {
        using var rig = new Rig();
        var w = rig.W;
        w.AddMovie(StampWorld.Movie(603), T0.AddDays(-1), id: rig.MovieId);
        var a = Viewer(Guid.NewGuid());
        var settings = rig.Settings("{}");
        string Hash() => rig.Provider.GetPinnedSnapshot(rig.MovieId, a, settings)!.PinnedHash;

        Assert.Equal(rig.Plain(), Hash());                                    // nothing yet
        w.Store.AddNew(a.Id, rig.Item, T0, "request");
        w.Now = T0.AddHours(1);
        var asNew = Hash();
        Assert.NotEqual(rig.Plain(), asNew);

        w.Library.Played(a.Id, rig.MovieId, false, T0.AddHours(2));         // watched it
        Assert.Equal(rig.Plain(), Hash());

        w.Store.AddUpgraded(rig.Item, T0.AddHours(3), "radarr:1");           // a better copy replaced it
        w.Now = T0.AddHours(4);
        var asUpgraded = Hash();
        Assert.NotEqual(rig.Plain(), asUpgraded);
        Assert.NotEqual(asNew, asUpgraded);

        w.Now = T0.AddHours(3).AddDays(7);                                    // expired at mint: None, the plain hash
        Assert.Equal(rig.Plain(), Hash());
        w.Now = T0.AddHours(3).AddDays(7).AddMilliseconds(-1);
        Assert.Equal(asUpgraded, Hash());
    }

    [Fact]
    public void WithOnlyStampsToDrawAPosterWithoutAStampKeepsItsPlainImageTag()
    {
        using var rig = new Rig();
        var w = rig.W;
        w.AddMovie(StampWorld.Movie(603), T0.AddDays(-1), id: rig.MovieId);
        var a = Viewer(Guid.NewGuid());
        // Only what StampItem uses for a movie's own Primary tag (no Spoiler Guard state, no parent image).
        var stamper = new NativePosterTagStamper(null!, null!, rig.Tokens, rig.Provider, null!, null!, null!, null!, Mock.Of<ILibraryManager>());
        string Stamp(string json)
        {
            var dto = new BaseItemDto { Id = rig.MovieId, Type = BaseItemKind.Movie, ImageTags = new Dictionary<ImageType, string> { [ImageType.Primary] = "0123abcd" } };
            stamper.StampItem(dto, new NativePosterTagStampSession(a, rig.Settings(json), "0123456789ab", null));
            return dto.ImageTags[ImageType.Primary];
        }

        Assert.True(rig.Settings("{}").AnyContentEnabled);
        Assert.False(rig.Settings("{}").AnyGroupEnabled);
        Assert.Equal("0123abcd", Stamp("{}"));                                    // stamps only, no stamp: untouched
        Assert.NotNull(ImageTagDecoration.GetVariant(Stamp("{genreTagsEnabled:true}")));   // a tag group: stamped as before

        w.Store.AddNew(a.Id, rig.Item, T0, "request");
        w.Now = T0.AddHours(1);
        var stamped = Stamp("{}");
        Assert.NotEqual("0123abcd", stamped);
        Assert.Equal("0123abcd", ImageTagDecoration.StripAll(stamped));
        Assert.True(PosterTagVariantToken.TryParse(ImageTagDecoration.GetVariant(stamped), out var variant));
        Assert.Equal(rig.Provider.GetPinnedSnapshot(rig.MovieId, a, rig.Settings("{}"))!.PinnedHash, variant.DataHash);
        Assert.NotEqual(rig.Plain(), variant.DataHash);

        w.Library.Played(a.Id, rig.MovieId, true, T0.AddHours(1));                // watched: back to the plain tag
        Assert.Equal("0123abcd", Stamp("{}"));
    }

    [Fact]
    public void AnAlreadyExpiredFactMintsThePlainHash()
    {
        using var rig = new Rig();
        var w = rig.W;
        w.AddMovie(StampWorld.Movie(603), T0.AddDays(-10), id: rig.MovieId);
        var a = Viewer(Guid.NewGuid());
        w.Store.AddNew(a.Id, rig.Item, T0.AddDays(-8), "request");
        var snapshot = rig.Provider.GetPinnedSnapshot(rig.MovieId, a, rig.Settings("{}"))!;
        Assert.Equal((AcquisitionStamp.None, rig.Plain()), (snapshot.Stamp, snapshot.PinnedHash));
        var token = rig.Tokens.Mint(a.Id, rig.MovieId, rig.Settings("{}").Digest, "r1", PosterTagVariantFlags.None, snapshot.PinnedHash);
        Assert.True(PosterTagVariantToken.TryParse(token, out var parsed));
        Assert.Equal(rig.Plain(), parsed.DataHash);
    }
}
