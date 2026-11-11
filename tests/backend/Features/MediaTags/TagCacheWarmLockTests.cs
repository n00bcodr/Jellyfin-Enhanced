using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Tmdb;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Moq;

namespace JE.Tests.Features.MediaTags;

[Collection("Plugin singleton")]
public class TagCacheWarmLockTests
{
    // The nightly refresh asks TMDB about every movie, a quarter of a second each, and MDBList about stale
    // scores. While it holds the cache lock, changed items, the awards and Leaving soon refreshes and some
    // admin saves wait. The lookups run before the lock is taken; the lock covers applying their answers.
    [Theory]
    [InlineData("build")][InlineData("reconcile")]
    public void RemoteLookupsRunOutsideTheCacheLockAndTheirAnswersAreApplied(string caller)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.TagCacheServerMode = true;
        config.TMDB_API_KEY = "key";
        config.MdblistApiKey = "fixture-key";
        config.RatingTagsSources = ["imdb"];
        TagCacheService? cache = null;
        var asked = new List<(string Path, bool LockHeld)>();
        void Record(HttpRequestMessage request) => asked.Add((request.RequestUri!.AbsolutePath,
            ((SemaphoreSlim)typeof(TagCacheService).GetField("_rebuildLock", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(cache)!).CurrentCount == 0));
        using var tmdb = new IntegrationTransport((request, _) =>
        {
            Record(request);
            return Task.FromResult(IntegrationTransport.Response("{\"keywords\":[{\"name\":\"aftercreditsstinger\"}]}"));
        });
        using var mdblistTransport = new IntegrationTransport((request, _) =>
        {
            if (request.RequestUri!.AbsolutePath == "/user") return Task.FromResult(IntegrationTransport.Response("{\"rate_limit\":1000,\"rate_limit_remaining\":1000}"));
            Record(request);
            return Task.FromResult(IntegrationTransport.Response("[{\"ids\":{\"tmdb\":7},\"ratings\":[{\"source\":\"imdb\",\"score\":81}]}]"));
        });
        using var responses = new TmdbResponseCache(tmdb, TimeProvider.System);
        var scenes = new StatusTagsScenesService(responses, f.Core.Logger) { RequestInterval = TimeSpan.Zero };
        using var mdblist = new MdblistService(mdblistTransport, f.Core.Paths.Object, f.Core.Logger);
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Film", ProviderIds = new() { ["Tmdb"] = "7" } };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            q.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Movie) ? new[] { movie.Id } : Array.Empty<Guid>());
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new BaseItem[] { movie });
        library.Setup(l => l.GetItemById<BaseItem>(movie.Id)).Returns(movie);
        library.Setup(l => l.GetItemById(movie.Id)).Returns(movie);
        cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger,
            new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger), mdblist, scenesService: scenes);
        using (cache)
        {
            if (caller == "reconcile")
            {
                // The cache already exists, so the nightly run reconciles instead of building.
                cache.BuildFullCache(null, default);
                Assert.Empty(asked);
            }

            config.StatusTagsEnabled = config.StatusTagsScenes = true;
            config.RatingTagsEnabled = true;
            if (caller == "reconcile") cache.ReconcileCache(null, default);
            else cache.BuildFullCache(null, default);

            Assert.Equal(["/3/movie/7/keywords", "/tmdb/movie/"], asked.Select(a => a.Path).Order(StringComparer.Ordinal));
            Assert.DoesNotContain(asked, a => a.LockHeld);
            Assert.True(cache.TryGetEntry(movie.Id, out var entry));
            Assert.Equal(new TagScenes(true, false), entry.Scenes);
            Assert.Equal(8.1, entry.Ratings!.Imdb);
        }
    }
}
