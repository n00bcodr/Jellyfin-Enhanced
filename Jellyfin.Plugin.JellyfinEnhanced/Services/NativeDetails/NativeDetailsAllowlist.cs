#if JF12
using System;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>How the facade answers an allowlisted native action for a synthetic id.</summary>
    public enum FacadeAnswer
    {
        /// <summary>The viewer-projected item DTO.</summary>
        Item,

        /// <summary>Empty theme songs/videos/soundtrack results owned by the item.</summary>
        ThemeMedia,

        /// <summary>An empty theme result owned by the item.</summary>
        ThemeResult,

        /// <summary>An empty item query result (collections, additional parts, intros, Live TV schedule, next up).</summary>
        EmptyQuery,

        /// <summary>An empty array (special features, local trailers).</summary>
        EmptyArray,

        /// <summary>Recommendations: visible library copies or synthetic cards, parental-filtered before paging.</summary>
        Similar,

        /// <summary>The series' seasons.</summary>
        Seasons,

        /// <summary>A season's episodes (honours the viewer's "display missing episodes").</summary>
        Episodes,

        /// <summary>Season/series ancestors of a season or episode.</summary>
        Ancestors,

        /// <summary>Artwork behind a signed grant.</summary>
        Image,

        /// <summary>Item batches: synthetic ids are left out (never answered, never passed on).</summary>
        Batch,

        /// <summary>
        /// A Jellyfin Enhanced route that answers synthetic page ids itself, by the title's key and
        /// under the page's own viewer rules (status, season rows, where a title opens): it runs.
        /// </summary>
        PassThrough,
    }

    /// <summary>One allowlisted native action.</summary>
    /// <param name="Controller">MVC controller name.</param>
    /// <param name="Action">MVC action name.</param>
    /// <param name="Methods">HTTP methods answered.</param>
    /// <param name="Answer">How it is answered.</param>
    /// <param name="IdArguments">The argument(s) that may carry the synthetic id (any other synthetic argument is refused).</param>
    /// <param name="Kinds">Synthetic kinds the id may name (others are refused).</param>
    public sealed record FacadeRoute(string Controller, string Action, string[] Methods, FacadeAnswer Answer, string[] IdArguments, SyntheticKind[] Kinds);

    /// <summary>
    /// The frozen, machine-readable list of native jellyfin-web 12.2 details-page requests the
    /// facade answers for synthetic ids (design §2 step 1). Every other action that names a
    /// synthetic id anywhere in its arguments is refused (404 for reads, 403 for writes) before the
    /// native action runs: favourites, played state, playback, queues, SyncPlay, playlists,
    /// collections, edits, refreshes, deletes, downloads and session commands.
    /// </summary>
    public static class NativeDetailsAllowlist
    {
        private static readonly string[] Get = { "GET" };
        private static readonly string[] GetHead = { "GET", "HEAD" };
        private static readonly string[] ItemId = { "itemId" };
        private static readonly SyntheticKind[] Titles = { SyntheticKind.Movie, SyntheticKind.Series, SyntheticKind.Season, SyntheticKind.Episode };
        private static readonly SyntheticKind[] MovieOrSeries = { SyntheticKind.Movie, SyntheticKind.Series };
        /// <summary>Titles and people (the reads a person page makes besides its item: no ancestors, no collections).</summary>
        private static readonly SyntheticKind[] TitlesAndPeople = { SyntheticKind.Movie, SyntheticKind.Series, SyntheticKind.Season, SyntheticKind.Episode, SyntheticKind.Person };
        /// <summary>Every page a synthetic id opens: titles, people, and genre/studio/network discovery pages.</summary>
        private static readonly SyntheticKind[] Pages = { SyntheticKind.Movie, SyntheticKind.Series, SyntheticKind.Season, SyntheticKind.Episode, SyntheticKind.Person, SyntheticKind.Genre, SyntheticKind.Studio, SyntheticKind.Network };
        private static readonly SyntheticKind[] Any = { SyntheticKind.Movie, SyntheticKind.Series, SyntheticKind.Season, SyntheticKind.Episode, SyntheticKind.Person };

        /// <summary>The allowlist.</summary>
        public static readonly IReadOnlyList<FacadeRoute> Routes = new[]
        {
            new FacadeRoute("UserLibrary", "GetItem", Get, FacadeAnswer.Item, ItemId, Pages),
            new FacadeRoute("UserLibrary", "GetItemLegacy", Get, FacadeAnswer.Item, ItemId, Pages),
            new FacadeRoute("UserLibrary", "GetIntros", Get, FacadeAnswer.EmptyQuery, ItemId, Titles),
            new FacadeRoute("UserLibrary", "GetIntrosLegacy", Get, FacadeAnswer.EmptyQuery, ItemId, Titles),
            new FacadeRoute("UserLibrary", "GetLocalTrailers", Get, FacadeAnswer.EmptyArray, ItemId, Titles),
            new FacadeRoute("UserLibrary", "GetLocalTrailersLegacy", Get, FacadeAnswer.EmptyArray, ItemId, Titles),
            new FacadeRoute("UserLibrary", "GetSpecialFeatures", Get, FacadeAnswer.EmptyArray, ItemId, Titles),
            new FacadeRoute("UserLibrary", "GetSpecialFeaturesLegacy", Get, FacadeAnswer.EmptyArray, ItemId, Titles),
            new FacadeRoute("Library", "GetThemeMedia", Get, FacadeAnswer.ThemeMedia, ItemId, Titles),
            new FacadeRoute("Library", "GetThemeSongs", Get, FacadeAnswer.ThemeResult, ItemId, Titles),
            new FacadeRoute("Library", "GetThemeVideos", Get, FacadeAnswer.ThemeResult, ItemId, Titles),
            new FacadeRoute("Library", "GetItemCollections", Get, FacadeAnswer.EmptyQuery, ItemId, TitlesAndPeople),
            new FacadeRoute("Library", "GetSimilarItems", Get, FacadeAnswer.Similar, ItemId, MovieOrSeries),
            new FacadeRoute("Library", "GetAncestors", Get, FacadeAnswer.Ancestors, ItemId, TitlesAndPeople),
            new FacadeRoute("Videos", "GetAdditionalPart", Get, FacadeAnswer.EmptyQuery, ItemId, Titles),
            new FacadeRoute("TvShows", "GetSeasons", Get, FacadeAnswer.Seasons, new[] { "seriesId" }, new[] { SyntheticKind.Series }),
            new FacadeRoute("TvShows", "GetEpisodes", Get, FacadeAnswer.Episodes, new[] { "seriesId", "seasonId" }, new[] { SyntheticKind.Series, SyntheticKind.Season }),
            new FacadeRoute("TvShows", "GetNextUp", Get, FacadeAnswer.EmptyQuery, new[] { "seriesId", "parentId" }, new[] { SyntheticKind.Series, SyntheticKind.Season }),
            new FacadeRoute("LiveTv", "GetLiveTvPrograms", Get, FacadeAnswer.EmptyQuery, new[] { "librarySeriesId" }, new[] { SyntheticKind.Series }),
            new FacadeRoute("Image", "GetItemImage", GetHead, FacadeAnswer.Image, ItemId, Any),
            new FacadeRoute("Image", "GetItemImageByIndex", GetHead, FacadeAnswer.Image, ItemId, Any),
            new FacadeRoute("Image", "GetItemImage2", GetHead, FacadeAnswer.Image, ItemId, Any),
            new FacadeRoute("Items", "GetItems", Get, FacadeAnswer.Batch, new[] { "ids", "excludeItemIds" }, Any),
            new FacadeRoute("Items", "GetItemsByUserIdLegacy", Get, FacadeAnswer.Batch, new[] { "ids", "excludeItemIds" }, Any),
            // Jellyfin Enhanced's own reads for the page (Requests & downloads, the navigator).
            new FacadeRoute("ArrStatus", "GetItemStatus", Get, FacadeAnswer.PassThrough, ItemId, Titles),
            new FacadeRoute("AcquireRequests", "Season", Get, FacadeAnswer.PassThrough, ItemId, new[] { SyntheticKind.Season }),
            new FacadeRoute("NativeDetails", "Resolve", Get, FacadeAnswer.PassThrough, new[] { "id" }, Titles),
        };

        private static readonly Dictionary<string, FacadeRoute> ByAction = Routes.ToDictionary(r => r.Controller + "." + r.Action, StringComparer.Ordinal);

        /// <summary>The allowlisted route for an action, or null.</summary>
        /// <param name="controller">Controller name.</param>
        /// <param name="action">Action name.</param>
        /// <returns>Route or null.</returns>
        public static FacadeRoute? Find(string? controller, string? action)
            => controller != null && action != null && ByAction.TryGetValue(controller + "." + action, out var route) ? route : null;
    }
}
#endif
