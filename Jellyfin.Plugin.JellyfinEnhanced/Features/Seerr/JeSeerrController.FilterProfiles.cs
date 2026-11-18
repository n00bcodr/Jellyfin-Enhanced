using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr
{
    /// <summary>A user's saved Seerr filter profiles (<see cref="DiscoveryFilterProfiles"/>): the Filters menu's Saved filters.</summary>
    public partial class JeSeerrController
    {
        /// <summary>
        /// A user's saved Seerr filter profiles (<see cref="DiscoveryFilterProfiles"/>), at most
        /// <see cref="DiscoveryFilterProfiles.MaxProfiles"/>.
        /// </summary>
        /// <param name="userId">The user.</param>
        /// <returns><c>{max, profiles}</c>, each profile <c>{id, name, filters}</c>, oldest first.</returns>
        [HttpGet("user-settings/{userId}/discovery-filter-profiles")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Produces("application/json")]
        public IActionResult GetDiscoveryFilterProfiles(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null) return authorizationResult;
            var store = _userConfigurationManager.GetUserConfiguration<DiscoveryFilterProfiles.Store>(authorizedUserId, DiscoveryFilterProfiles.File);
            return Ok(new
            {
                max = DiscoveryFilterProfiles.MaxProfiles,
                profiles = (store.Profiles ?? new List<DiscoveryFilterProfiles.Profile>()).Select(DiscoveryFilterProfiles.ToDocument),
            });
        }

        /// <summary>
        /// Saves a filter profile <c>{name, filters}</c> to the user's own list. A profile of the same name (ignoring
        /// case) takes the new filters and keeps its id and place; otherwise it is added with a new id.
        /// </summary>
        /// <param name="userId">The user.</param>
        /// <param name="body">The profile.</param>
        /// <returns>200 <c>{profile}</c>; 400 <c>{error}</c> (<c>name</c>, <c>filters</c>, <c>empty</c>, or <c>full</c> with <c>max</c>).</returns>
        [HttpPost("user-settings/{userId}/discovery-filter-profiles")]
        [Authorize]
        [RequestSizeLimit(DiscoveryFilterProfiles.MaxRequestBytes)]
        [Produces("application/json")]
        public IActionResult SaveDiscoveryFilterProfile(string userId, [FromBody] JsonElement body)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null) return authorizationResult;
            if (!DiscoveryFilterProfiles.TryRead(body, out var name, out var filters, out var error))
            {
                return BadRequest(new { error });
            }

            DiscoveryFilterProfiles.Profile? saved = null;
            try
            {
                _userConfigurationManager.RmwUserConfiguration<DiscoveryFilterProfiles.Store>(authorizedUserId, DiscoveryFilterProfiles.File, store =>
                {
                    store.Profiles ??= new List<DiscoveryFilterProfiles.Profile>();
                    var same = store.Profiles.Find(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase));
                    if (same != null)
                    {
                        same.Name = name;
                        same.Filters = filters;
                        saved = same;
                        return 1;
                    }

                    if (store.Profiles.Count >= DiscoveryFilterProfiles.MaxProfiles) return 0;
                    saved = new DiscoveryFilterProfiles.Profile { Id = Guid.NewGuid().ToString("N")[..12], Name = name, Filters = filters };
                    store.Profiles.Add(saved);
                    return 1;
                });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save a Seerr filter profile for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { error = "save" });
            }

            if (saved == null) return BadRequest(new { error = "full", max = DiscoveryFilterProfiles.MaxProfiles });
            return Ok(new { profile = DiscoveryFilterProfiles.ToDocument(saved) });
        }

        /// <summary>Deletes one of the user's own filter profiles.</summary>
        /// <param name="userId">The user.</param>
        /// <param name="profileId">The profile's id.</param>
        /// <returns>200, or 404 when the user has no such profile.</returns>
        [HttpDelete("user-settings/{userId}/discovery-filter-profiles/{profileId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DeleteDiscoveryFilterProfile(string userId, string profileId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null) return authorizationResult;
            int removed;
            try
            {
                removed = _userConfigurationManager.RmwUserConfiguration<DiscoveryFilterProfiles.Store>(authorizedUserId, DiscoveryFilterProfiles.File, store =>
                    store.Profiles?.RemoveAll(p => string.Equals(p.Id, profileId, StringComparison.Ordinal)) ?? 0);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to delete a Seerr filter profile for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { error = "save" });
            }

            return removed > 0 ? Ok(new { success = true }) : NotFound(new { error = "missing" });
        }
    }
}
