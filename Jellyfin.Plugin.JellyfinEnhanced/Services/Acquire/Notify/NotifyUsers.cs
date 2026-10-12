using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify
{
    /// <summary>The Jellyfin users notifications need to know about.</summary>
    public interface INotifyUsers
    {
        /// <summary>Every administrator (admin events go to them).</summary>
        IReadOnlyList<Guid> Admins();

        /// <summary>The user still exists.</summary>
        bool Exists(Guid userId);

        /// <summary>
        /// The user exists and isn't disabled: only such a user is told anything (a disabled account,
        /// the usual way to cut someone off, gets no inbox rows, pushes or e-mails).
        /// </summary>
        bool IsActive(Guid userId);

        /// <summary>The user's display name (administrators' texts only), or null.</summary>
        string? Name(Guid userId);

        /// <summary>The name of a Jellyfin item (a movie or series), or null.</summary>
        string? ItemName(Guid itemId);
    }

    /// <summary><see cref="INotifyUsers"/> over Jellyfin's user manager.</summary>
    public sealed class JellyfinNotifyUsers : INotifyUsers
    {
        private readonly IUserManager _users;
        private readonly ILibraryManager _library;

        /// <summary>Creates it (DI).</summary>
        public JellyfinNotifyUsers(IUserManager users, ILibraryManager library)
        {
            _users = users;
            _library = library;
        }

        /// <inheritdoc />
        public IReadOnlyList<Guid> Admins()
            => _users.GetAllUsers().Where(u => u.HasPermission(PermissionKind.IsAdministrator) && !u.HasPermission(PermissionKind.IsDisabled)).Select(u => u.Id).ToList();

        /// <inheritdoc />
        public bool Exists(Guid userId) => Helpers.ArrCaller.Find(userId, _users) != null;

        /// <inheritdoc />
        public bool IsActive(Guid userId) => Helpers.ArrCaller.Find(userId, _users) is { } user && !user.HasPermission(PermissionKind.IsDisabled);

        /// <inheritdoc />
        public string? Name(Guid userId) => Helpers.ArrCaller.Find(userId, _users)?.Username;

        /// <inheritdoc />
        public string? ItemName(Guid itemId) => _library.GetItemById(itemId)?.Name;

    }
}
