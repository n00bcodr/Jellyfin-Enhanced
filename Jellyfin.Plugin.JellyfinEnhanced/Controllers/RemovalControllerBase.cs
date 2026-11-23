using System;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>What the Maintainerr and Reclaimerr item-menu controllers share: who is asking and which item they mean.</summary>
    public abstract class RemovalControllerBase : ControllerBase
    {
        protected IUserManager UserManager { get; }
        protected ILibraryManager LibraryManager { get; }

        protected RemovalControllerBase(IUserManager userManager, ILibraryManager libraryManager)
        {
            UserManager = userManager;
            LibraryManager = libraryManager;
        }

        protected bool IsAdmin()
        {
            if (User.IsInRole("Administrator")) return true;
            try
            {
                var id = UserHelper.GetCurrentUserId(User);
                var user = id.HasValue && id.Value != Guid.Empty ? UserManager.GetUserById(id.Value) : null;
                return user != null && user.HasPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator);
            }
            catch { return false; }
        }

        /// <summary>The signed-in Jellyfin user's name (null for an API key), the identity Reclaimerr actions are attributed to.</summary>
        protected string? CurrentUserName()
        {
            try
            {
                var id = UserHelper.GetCurrentUserId(User);
                return id.HasValue && id.Value != Guid.Empty ? UserManager.GetUserById(id.Value)?.Username : null;
            }
            catch { return null; }
        }

        /// <summary>Whether the signed-in user may open the item: its rating and tags, and the library it is in (standalone visibility).</summary>
        protected bool CanSee(BaseItem item)
        {
            try
            {
                var id = UserHelper.GetCurrentUserId(User);
                var user = id.HasValue && id.Value != Guid.Empty ? UserManager.GetUserById(id.Value) : null;
                return user != null && item.IsVisibleStandalone(user);
            }
            catch { return false; }
        }

        protected BaseItem? Find(Guid itemId) => itemId == Guid.Empty ? null : LibraryManager.GetItemById(itemId);
    }
}
