using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Auth;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Http;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Activity
{
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class JeActivityController : JeControllerBase
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IItemRepository _itemRepository;
        private readonly Shared.SpoilerGuard.SpoilerSeerrRedactor _spoilerSeerrRedactor;

        public JeActivityController(
            Logger logger,
            IUserManager userManager,
            ILibraryManager libraryManager,
            UserConfigurationManager userConfigurationManager,
            IItemRepository itemRepository,
            Shared.SpoilerGuard.SpoilerSeerrRedactor spoilerSeerrRedactor)
            : base(userManager, logger, userConfigurationManager)
        {
            _libraryManager = libraryManager;
            _itemRepository = itemRepository;
            _spoilerSeerrRedactor = spoilerSeerrRedactor;
        }

        // ─── Activity Feed (recently watched / favorited / reviewed) ─────────────

        [HttpGet("activity")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Produces("application/json")]
        public IActionResult GetActivityFeed([FromQuery] int limit = 50, CancellationToken cancellationToken = default)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config?.ActivityFeedEnabled != true) return NotFound();

            var viewerUserId = UserHelper.GetCurrentUserId(User);
            if (!viewerUserId.HasValue || viewerUserId.Value == Guid.Empty) return Forbid();
            var viewer = _userManager.GetUserById(viewerUserId.Value);
            if (viewer == null) return Forbid();

            cancellationToken.ThrowIfCancellationRequested();
            var activity = config.ActivityFeedShowWatched || config.ActivityFeedShowFavorited
                ? _userConfigurationManager.GetAllActivity().Entries.Values.AsEnumerable()
                : Enumerable.Empty<ActivityEntry>();
            cancellationToken.ThrowIfCancellationRequested();
            var reviews = config.ActivityFeedShowReviewed && config.ShowUserReviews
                ? _userConfigurationManager.GetAllReviews().Reviews.Values.AsEnumerable()
                : Enumerable.Empty<UserReview>();

            var builder = new Services.ActivityFeedBuilder(_libraryManager, _userManager, _itemRepository, _logger);
            var guards = _spoilerSeerrRedactor.LoadRows(viewerUserId.Value.ToString(), HttpContext);
            var items = builder.Build(activity, reviews, viewer, IsAdminUser(), config, limit, cancellationToken, guards);
            return Ok(new { items });
        }
    }
}
