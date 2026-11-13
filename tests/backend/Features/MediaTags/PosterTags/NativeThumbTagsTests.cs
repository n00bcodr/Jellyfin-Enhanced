using System.Security.Claims;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Moq;

namespace JE.Tests.Features.MediaTags;

// Upstream e0c8763d: a landscape card (a movie in Continue Watching) draws the item's own Thumb, so native poster
// tags are stamped on the Thumb tag as on the Primary, and the image filter treats a Thumb request like a Primary one.
[Collection("Plugin singleton")]
public class NativeThumbTagsTests
{
    [Fact]
    public void AnItemsOwnThumbIsStampedAndItsBlurhashFollowsTheNewTag()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.NativePosterTagsEnabled = true;
        f.Plugin.Configuration.NativePosterTagsWebClientNames = "";
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(user.Id)).Returns(user);
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Movie", Genres = ["Drama"] };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemById(movie.Id)).Returns(movie);
        f.Core.Manager.SaveUserConfiguration(user.Id.ToString("N"), "settings.json", new JellyfinEnhancedUserSettings { GenreTagsEnabled = true, TagLayoutSettingsVersion = 1, TagLayout = "corners" });
        var userCache = new PosterTagUserCache(users.Object);
        using var provider = new PosterTagSettingsProvider(f.Core.Manager, userCache);
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        using var data = new PosterTagDataProvider(cache, library.Object, null!, null!, null!, f.Core.Logger);
        var tokens = PosterTagVariantToken.CreateForPath(Path.Combine(f.Core.Root, "native-key"), _ => { });
        var stamper = new NativePosterTagStamper(new NativeClientPolicy(), provider, tokens, data, new SpoilerIdentityService(users.Object, f.Core.Logger, f.Core.Paths.Object), null!, null!, userCache, library.Object);
        var http = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-Client", "Jellyfin for Android TV")], "test")) };
        var session = stamper.Begin(http, user.Id);
        Assert.NotNull(session);

        var dto = new BaseItemDto
        {
            Id = movie.Id, Type = BaseItemKind.Movie,
            ImageTags = new() { [ImageType.Primary] = "poster", [ImageType.Thumb] = "thumb", [ImageType.Logo] = "logo" },
            ImageBlurHashes = new()
            {
                [ImageType.Primary] = new() { ["poster"] = "poster-hash" },
                [ImageType.Thumb] = new() { ["thumb"] = "thumb-hash" },
            },
        };
        stamper.StampItem(dto, session!);

        var thumb = dto.ImageTags[ImageType.Thumb];
        Assert.StartsWith("thumb", thumb, StringComparison.Ordinal);
        Assert.NotNull(ImageTagDecoration.GetVariant(thumb));
        Assert.Equal("thumb-hash", dto.ImageBlurHashes[ImageType.Thumb][thumb]);
        Assert.False(dto.ImageBlurHashes[ImageType.Thumb].ContainsKey("thumb"));
        // The Primary is stamped as before, and other image types keep their tags.
        Assert.NotNull(ImageTagDecoration.GetVariant(dto.ImageTags[ImageType.Primary]));
        Assert.Equal("poster-hash", dto.ImageBlurHashes[ImageType.Primary][dto.ImageTags[ImageType.Primary]]);
        Assert.Equal("logo", dto.ImageTags[ImageType.Logo]);

        // Stamping the same answer again changes nothing.
        stamper.StampItem(dto, session!);
        Assert.Equal(thumb, dto.ImageTags[ImageType.Thumb]);
    }

    [Theory]
    [InlineData("Thumb", true)]
    [InlineData("Primary", true)]
    [InlineData("Backdrop", false)]
    public async Task AStampedThumbRequestIsTheFiltersOwnLikeAPrimaryOne(string imageType, bool handled)
    {
        // With native tags switched off since the URL was issued, a stamped URL the filter handles is served as the
        // original but never cached under that URL; one it does not handle keeps the original's year-long caching.
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.NativePosterTagsEnabled = false;
        var filter = new PosterTagImageFilter(null!, null!, null!, null!, null!, null!, null!, null!, null!, f.Core.Logger);
        var http = new DefaultHttpContext();
        var descriptor = new ActionDescriptor { RouteValues = new Dictionary<string, string?> { ["controller"] = "Image", ["action"] = "GetItemImage" } };
        var context = new ActionContext(http, new RouteData(), descriptor, new ModelStateDictionary());
        var arguments = new Dictionary<string, object?>
        {
            ["itemId"] = Guid.NewGuid(), ["imageType"] = imageType, ["imageIndex"] = 0,
            ["tag"] = "thumb" + ImageTagDecoration.VariantSentinel + new string('a', ImageTagDecoration.VariantHexLength),
        };
        Assert.NotNull(ImageTagDecoration.GetVariant((string)arguments["tag"]!));
        await filter.OnActionExecutionAsync(new ActionExecutingContext(context, [], arguments, new object()), () =>
        {
            http.Response.Headers.CacheControl = "public, max-age=31536000";
            return Task.FromResult(new ActionExecutedContext(context, [], new object()) { Result = new OkResult() });
        });

        var cacheControl = http.Response.Headers.CacheControl.ToString();
        Assert.Equal(handled, cacheControl.Contains("no-store", StringComparison.Ordinal));
    }
}
