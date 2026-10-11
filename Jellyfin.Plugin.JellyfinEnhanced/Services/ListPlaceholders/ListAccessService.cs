using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>The inputs of the list permission rules (design §4).</summary>
    /// <param name="Kind">List kind.</param>
    /// <param name="IsAdmin">Caller is a Jellyfin administrator.</param>
    /// <param name="CanManageCollections">Caller has the collection-management permission.</param>
    /// <param name="IsOwner">Caller owns the playlist.</param>
    /// <param name="HasShare">The playlist is shared with the caller.</param>
    /// <param name="ShareCanEdit">The caller's share may edit.</param>
    /// <param name="OpenAccess">The playlist is public.</param>
    /// <param name="EntityVisible">Jellyfin's own entity visibility for the caller.</param>
    public readonly record struct ListAccessFacts(
        string Kind,
        bool IsAdmin,
        bool CanManageCollections,
        bool IsOwner,
        bool HasShare,
        bool ShareCanEdit,
        bool OpenAccess,
        bool EntityVisible);

    /// <summary>What a caller may do with a list.</summary>
    /// <param name="CanView">May see the list and its placeholders.</param>
    /// <param name="CanEdit">May change placeholders (JE rules).</param>
    /// <param name="NativeCanEdit">May edit the list in Jellyfin itself.</param>
    public readonly record struct ListPermissions(bool CanView, bool CanEdit, bool NativeCanEdit);

    /// <summary>
    /// The permission rules, as a pure function (design §4):
    /// <list type="bullet">
    /// <item>Playlist view: Jellyfin's item-endpoint rule — entity visible AND (public OR owner OR any share); admins
    /// can always view (they can edit, see below).</item>
    /// <item>Playlist edit: owner OR CanEdit share (Jellyfin's native rule), OR admin — a deliberate JE extension;
    /// real-item mutations then run as the owner.</item>
    /// <item>Collection view: the collection is visible to the caller. Edit: view AND (admin OR collection manager),
    /// Jellyfin's CollectionManagement policy.</item>
    /// </list>
    /// </summary>
    public static class ListAccessRules
    {
        /// <summary>Evaluates the rules.</summary>
        /// <param name="facts">Inputs.</param>
        /// <returns>Permissions.</returns>
        public static ListPermissions Evaluate(ListAccessFacts facts)
        {
            if (facts.Kind == ListKinds.Collection)
            {
                var view = facts.EntityVisible;
                var edit = view && (facts.IsAdmin || facts.CanManageCollections);
                return new ListPermissions(view, edit, edit);
            }

            var native = facts.EntityVisible && (facts.IsOwner || facts.ShareCanEdit);
            var canView = facts.IsAdmin || (facts.EntityVisible && (facts.OpenAccess || facts.IsOwner || facts.HasShare));
            return new ListPermissions(canView, native || facts.IsAdmin, native);
        }
    }

    /// <summary>A resolved list plus the caller's rights on it.</summary>
    public sealed class ListAccess
    {
        /// <summary>The list.</summary>
        public required ListInfo List { get; init; }

        /// <summary>The caller.</summary>
        public required User User { get; init; }

        /// <summary>The caller's id ("N").</summary>
        public string UserIdN => User.Id.ToString("N", System.Globalization.CultureInfo.InvariantCulture);

        /// <summary>Caller is an administrator.</summary>
        public bool IsAdmin { get; init; }

        /// <summary>Permissions.</summary>
        public ListPermissions Permissions { get; init; }

        /// <summary>The playlist owner (null for collections or a deleted owner).</summary>
        public User? Owner { get; init; }

        /// <summary>List id ("N").</summary>
        public string ListIdN => List.Id.ToString("N", System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Resolves lists and evaluates who may view/edit them, plus the parental filter for placeholders
    /// (restricted users only; anything unverifiable is hidden except from the user who added it).
    /// </summary>
    public sealed class ListAccessService
    {
        /// <summary>Overall time budget for parental checks of one list.</summary>
        public static readonly TimeSpan ParentalBudget = TimeSpan.FromSeconds(8);

        private const int ParentalConcurrency = 8;

        private readonly IListPlaceholderHost _host;
        private readonly IUserManager _userManager;
        private readonly SeerrParentalFilter _parentalFilter;
        private readonly Logger _logger;

        /// <summary>Creates the service.</summary>
        /// <param name="host">Jellyfin seam.</param>
        /// <param name="userManager">User manager.</param>
        /// <param name="parentalFilter">Seerr parental filter.</param>
        /// <param name="logger">JE logger.</param>
        public ListAccessService(IListPlaceholderHost host, IUserManager userManager, SeerrParentalFilter parentalFilter, Logger logger)
        {
            _host = host;
            _userManager = userManager;
            _parentalFilter = parentalFilter;
            _logger = logger;
        }

        /// <summary>True for administrators.</summary>
        /// <param name="user">User.</param>
        /// <returns>Whether the user is an administrator.</returns>
        public static bool IsAdmin(User user) => user.HasPermission(PermissionKind.IsAdministrator);

        /// <summary>True for administrators and collection managers.</summary>
        /// <param name="user">User.</param>
        /// <returns>Whether the user may manage collections.</returns>
        public static bool CanManageCollections(User user) =>
            user.HasPermission(PermissionKind.IsAdministrator) || user.HasPermission(PermissionKind.EnableCollectionManagement);

        /// <summary>Resolves a list and the caller's permissions. Null when the id is not a playlist/collection.</summary>
        /// <param name="listId">List id.</param>
        /// <param name="user">Caller.</param>
        /// <returns>The access, or null.</returns>
        public ListAccess? Resolve(Guid listId, User user)
        {
            var list = _host.GetList(listId);
            return list == null ? null : Evaluate(list, user);
        }

        /// <summary>Evaluates the caller's permissions on an already resolved list.</summary>
        /// <param name="list">List.</param>
        /// <param name="user">Caller.</param>
        /// <returns>The access.</returns>
        public ListAccess Evaluate(ListInfo list, User user) => Evaluate(list, user, adminOverride: true);

        /// <summary>
        /// Evaluates the caller's permissions with Jellyfin's own rules only: no JE admin extension, so an administrator
        /// sees and edits another user's private playlist only when Jellyfin itself would let them (public, owner or
        /// share). Collections are unchanged (administrators manage collections natively). Used where acting on a list
        /// must not rely on the admin override, e.g. requests made in the playing user's name.
        /// </summary>
        /// <param name="list">List.</param>
        /// <param name="user">Caller.</param>
        /// <returns>The access (<see cref="ListAccess.IsAdmin"/> still reports the real role).</returns>
        public ListAccess EvaluateNative(ListInfo list, User user) => Evaluate(list, user, adminOverride: false);

        private ListAccess Evaluate(ListInfo list, User user, bool adminOverride)
        {
            var admin = IsAdmin(user);
            var share = list.Shares.FirstOrDefault(s => s.UserId == user.Id);
            var hasShare = list.Shares.Any(s => s.UserId == user.Id);
            bool visible;
            try
            {
                visible = _host.IsListVisible(list.Id, user);
            }
            catch (Exception ex)
            {
                _logger.Warning($"[ListPlaceholders] Visibility check failed for list {list.Id:N}: {ex.Message}");
                visible = false;
            }

            var permissions = ListAccessRules.Evaluate(new ListAccessFacts(
                list.Kind,
                admin && adminOverride,
                CanManageCollections(user),
                list.Kind == ListKinds.Playlist && list.OwnerId == user.Id,
                hasShare,
                hasShare && share.CanEdit,
                list.OpenAccess,
                visible));

            User? owner = null;
            if (list.Kind == ListKinds.Playlist && list.OwnerId != Guid.Empty)
            {
                owner = list.OwnerId == user.Id ? user : _userManager.GetUserById(list.OwnerId);
            }

            return new ListAccess
            {
                List = list,
                User = user,
                IsAdmin = admin,
                Permissions = permissions,
                Owner = owner,
            };
        }

        /// <summary>True when the user's parental controls may hide titles (Seerr parental filter policy).</summary>
        /// <param name="user">User.</param>
        /// <returns>Whether the user is restricted.</returns>
        public bool IsRestricted(User user) =>
            _parentalFilter.TryGetRestrictedPolicy(user.Id.ToString("N", System.Globalization.CultureInfo.InvariantCulture), out _);

        /// <summary>
        /// The users with parental controls who may see a list (Jellyfin's visibility or JE's own view permission).
        /// Fails closed: a user whose visibility can't be checked counts as a viewer. Used for what every viewer sees
        /// at once, e.g. the list's poster collage.
        /// </summary>
        /// <param name="list">List.</param>
        /// <returns>The restricted users who can see it.</returns>
        public IReadOnlyList<User> GetRestrictedViewers(ListInfo list)
        {
            var viewers = new List<User>();
            foreach (var user in _userManager.GetAllUsers())
            {
                if (user == null || !IsRestricted(user))
                {
                    continue;
                }

                bool canView;
                try
                {
                    canView = _host.IsListVisible(list.Id, user) || Evaluate(list, user).Permissions.CanView;
                }
                catch (Exception ex)
                {
                    _logger.Debug($"[ListPlaceholders] Visibility check failed for list {list.Id:N}: {ex.Message}");
                    canView = true;
                }

                if (canView)
                {
                    viewers.Add(user);
                }
            }

            return viewers;
        }

        /// <summary>Whether a TMDB title is blocked for the user (false for unrestricted users, no lookups).</summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <param name="user">User.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>Whether it is blocked.</returns>
        public Task<bool> IsTitleBlockedAsync(string mediaType, int tmdbId, User user, CancellationToken cancellationToken) =>
            _parentalFilter.IsBlockedAsync(mediaType, tmdbId, user.Id.ToString("N", System.Globalization.CultureInfo.InvariantCulture), cancellationToken);

        /// <summary>
        /// Ids of the placeholders the user must not see. Unrestricted users: none, without any lookup. Restricted
        /// users: blocked titles, plus custom/unverifiable entries unless the user added them. Lookups that don't finish
        /// within <see cref="ParentalBudget"/> fail closed (hidden).
        /// </summary>
        /// <param name="placeholders">Placeholders.</param>
        /// <param name="user">Viewer.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>Hidden ids.</returns>
        public async Task<HashSet<string>> GetHiddenPlaceholderIdsAsync(IReadOnlyList<Placeholder> placeholders, User user, CancellationToken cancellationToken)
        {
            var hidden = new HashSet<string>(StringComparer.Ordinal);
            if (placeholders.Count == 0 || !IsRestricted(user))
            {
                return hidden;
            }

            var userIdN = user.Id.ToString("N", System.Globalization.CultureInfo.InvariantCulture);
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            budget.CancelAfter(ParentalBudget);
            using var gate = new SemaphoreSlim(ParentalConcurrency);
            var checks = new List<Task>();
            foreach (var placeholder in placeholders)
            {
                if (placeholder.Kind == PlaceholderKinds.Custom || placeholder.TmdbId is not > 0)
                {
                    if (!string.Equals(placeholder.AddedBy, userIdN, StringComparison.Ordinal))
                    {
                        lock (hidden)
                        {
                            hidden.Add(placeholder.Id);
                        }
                    }

                    continue;
                }

                checks.Add(CheckAsync(placeholder));
            }

            await Task.WhenAll(checks).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return hidden;

            async Task CheckAsync(Placeholder placeholder)
            {
                var blocked = true;
                try
                {
                    await gate.WaitAsync(budget.Token).ConfigureAwait(false);
                    try
                    {
                        blocked = await _parentalFilter.IsBlockedAsync(placeholder.MediaType, placeholder.TmdbId!.Value, userIdN, budget.Token).ConfigureAwait(false);
                    }
                    finally
                    {
                        gate.Release();
                    }
                }
                catch (OperationCanceledException)
                {
                    blocked = true; // over budget: fail closed
                }

                if (blocked)
                {
                    lock (hidden)
                    {
                        hidden.Add(placeholder.Id);
                    }
                }
            }
        }
    }
}
