using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
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
    /// Resolves lists and evaluates who may view/edit them, plus the parental filter for list entries
    /// (restricted users only; anything unverifiable is hidden except from the user who added it).
    /// </summary>
    public sealed class ListAccessService
    {
        /// <summary>Overall time budget for parental checks of one list.</summary>
        public static readonly TimeSpan ParentalBudget = TimeSpan.FromSeconds(8);

        private const int ParentalConcurrency = 8;

        private readonly IListHost _host;
        private readonly IUserManager _userManager;
        private readonly SeerrParentalFilter _parentalFilter;
        private readonly Logger _logger;

        /// <summary>Creates the service.</summary>
        /// <param name="host">Jellyfin seam.</param>
        /// <param name="userManager">User manager.</param>
        /// <param name="parentalFilter">Seerr parental filter.</param>
        /// <param name="logger">JE logger.</param>
        public ListAccessService(IListHost host, IUserManager userManager, SeerrParentalFilter parentalFilter, Logger logger)
        {
            _host = host;
            _userManager = userManager;
            _parentalFilter = parentalFilter;
            _logger = logger;
            Gate = new ListGate(host, userManager, this);
        }

        /// <summary>The one list access gate (every list write to Jellyfin and every answer with list contents goes through it).</summary>
        public ListGate Gate { get; }

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

        /// <summary>
        /// The caller's access to the same list now (see <see cref="ListGate.Current"/>). Null when the person or the list
        /// is gone or they can no longer see it.
        /// </summary>
        /// <param name="access">The access checked earlier.</param>
        /// <returns>The current access, or null.</returns>
        public ListAccess? Current(ListAccess access) => Gate.Current(access);

        /// <summary>Captures the common evidence boundary before asynchronous list preparation.</summary>
        internal EvidencePublication CapturePublication() => _parentalFilter.CapturePublication();

        /// <summary>
        /// The parental limits a visibility was checked with, as text: equal stamps decide the same placeholders
        /// (<see cref="PlaceholderVisibility.Matches"/>). "-" for a user nothing is hidden from.
        /// </summary>
        /// <param name="user">User.</param>
        /// <returns>The stamp.</returns>
        internal string ParentalStamp(User user)
        {
            // The person as the caller just read them (the gate reads them right before): not read again.
            if (!_parentalFilter.TryGetRestrictedPolicy(user, out var policy))
            {
                return "-";
            }

            static string Tags(HashSet<string>? tags) => tags == null ? string.Empty : string.Join("\u001f", tags.OrderBy(t => t, StringComparer.OrdinalIgnoreCase));
            return string.Join(
                "|",
                policy.MaxScore?.ToString(System.Globalization.CultureInfo.InvariantCulture),
                policy.MaxSubScore?.ToString(System.Globalization.CultureInfo.InvariantCulture),
                policy.BlockUnratedMovies ? "m" : string.Empty,
                policy.BlockUnratedSeries ? "s" : string.Empty,
                Tags(policy.BlockedTags),
                Tags(policy.AllowedTags),
                CapturePublication().Revision);
        }

        /// <summary>
        /// A person's policy revision as text (see <see cref="ListGate.Policy"/>): disabled, administrator, collection
        /// management, library access (all, enabled and blocked folders), Jellyfin's parental limits (rating, tags, unrated
        /// kinds) and the Seerr parental policy (<see cref="ParentalStamp"/>). Equal stamps decide the same things, so
        /// something composed for the person under one stamp (a status with an administrator's details) is theirs only
        /// while the stamp holds.
        /// </summary>
        /// <param name="user">User (as just read).</param>
        /// <returns>The stamp.</returns>
        internal string PolicyStamp(User user)
        {
            static string Joined<T>(IEnumerable<T> values) => string.Join(",", values.Select(v => System.Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture)).OrderBy(v => v, StringComparer.Ordinal));
            var allFolders = user.HasPermission(PermissionKind.EnableAllFolders);
            return string.Join(
                "|",
                user.HasPermission(PermissionKind.IsDisabled) ? "d" : string.Empty,
                IsAdmin(user) ? "a" : string.Empty,
                CanManageCollections(user) ? "c" : string.Empty,
                allFolders ? "*" : Joined(user.GetPreferenceValues<Guid>(PreferenceKind.EnabledFolders)),
                Joined(user.GetPreferenceValues<Guid>(PreferenceKind.BlockedMediaFolders)),
                user.MaxParentalRatingScore?.ToString(System.Globalization.CultureInfo.InvariantCulture),
                user.MaxParentalRatingSubScore?.ToString(System.Globalization.CultureInfo.InvariantCulture),
                Joined(user.GetPreferenceValues<UnratedItem>(PreferenceKind.BlockUnratedItems)),
                Joined(user.GetPreference(PreferenceKind.BlockedTags) ?? Array.Empty<string>()),
                Joined(user.GetPreference(PreferenceKind.AllowedTags) ?? Array.Empty<string>()),
                ParentalStamp(user));
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
                _logger.Warning($"[Lists] Visibility check failed for list {list.Id:N}: {ex.Message}");
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
            _parentalFilter.TryGetRestrictedPolicy(user, out _);

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
                    _logger.Debug($"[Lists] Visibility check failed for list {list.Id:N}: {ex.Message}");
                    canView = true;
                }

                if (canView)
                {
                    viewers.Add(user);
                }
            }

            return viewers;
        }

        /// <summary>
        /// Tri-state parental decision of an absent title for a restricted user: true allowed, false blocked (a verified
        /// rating or tags the person's limits refuse), null unknown (the lookup failed, timed out or the title is unrated:
        /// hidden now, a later check may show it). Unrestricted users: true without a lookup.
        /// </summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <param name="userIdN">User ("N").</param>
        /// <param name="cancellationToken">Cancellation (the overall budget).</param>
        /// <returns>The decision.</returns>
        public async Task<bool?> CheckTitleAsync(string mediaType, int tmdbId, string userIdN, CancellationToken cancellationToken)
        {
            if (!_parentalFilter.TryGetRestrictedPolicy(userIdN, out var policy))
            {
                return true;
            }

            return await ListContinuation.Await(() => CheckTitleAsync(mediaType, tmdbId, policy, Guid.Parse(userIdN), cancellationToken)).ConfigureAwait(false);
        }

        /// <summary>
        /// <see cref="CheckTitleAsync(string, int, string, CancellationToken)"/> under a policy already resolved for the
        /// person (many titles of one list are checked with one read of the person).
        /// </summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <param name="policy">The person's parental policy.</param>
        /// <param name="cancellationToken">Cancellation (the overall budget).</param>
        /// <returns>The decision.</returns>
        internal async Task<bool?> CheckTitleAsync(string mediaType, int tmdbId, SeerrParentalFilter.Policy policy, Guid viewer, CancellationToken cancellationToken)
        {
            if (!policy.IsRestricted)
            {
                return true;
            }

            if (await ListContinuation.Await(() => _parentalFilter.CheckAbsentAsync(mediaType, tmdbId, policy, viewer, cancellationToken)).ConfigureAwait(false) == true)
            {
                return true;
            }

            cancellationToken.ThrowIfCancellationRequested();
            // A verified signature that the limits refuse is a decision; no (or an unrated) signature is unknown.
            return _parentalFilter.MaySeeAbsent(mediaType, tmdbId, policy, out var facts) ? true : facts != null ? false : null;
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
        /// <param name="unverified">
        /// When given, receives the hidden ids whose check could not be verified (lookup failed or over budget), as
        /// opposed to titles the user's controls block: a later check may show them.
        /// </param>
        /// <returns>Hidden ids.</returns>
        public async Task<HashSet<string>> GetHiddenPlaceholderIdsAsync(IReadOnlyList<Placeholder> placeholders, User user, CancellationToken cancellationToken, ISet<string>? unverified = null)
        {
            var hidden = new HashSet<string>(StringComparer.Ordinal);
            // The person's limits as the caller just read them, once for every title (not one read of the person each).
            if (placeholders.Count == 0 || !_parentalFilter.TryGetRestrictedPolicy(user, out var policy))
            {
                return hidden;
            }

            var publication = CapturePublication();
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

            await ListContinuation.Await(() => Task.WhenAll(checks)).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (!publication.Current)
            {
                foreach (var placeholder in placeholders) { hidden.Add(placeholder.Id); unverified?.Add(placeholder.Id); }
            }
            return hidden;

            async Task CheckAsync(Placeholder placeholder)
            {
                bool? blocked = null;
                try
                {
                    using (await ListContinuation.AwaitLock(gate, budget.Token).ConfigureAwait(false))
                    {
                        var allowed = await ListContinuation.Await(() => CheckTitleAsync(placeholder.MediaType, placeholder.TmdbId!.Value, policy, user.Id, budget.Token)).ConfigureAwait(false);
                        blocked = allowed.HasValue ? !allowed.Value : null;
                    }
                }
                catch (OperationCanceledException)
                {
                    blocked = null; // over budget: fail closed
                }

                if (blocked != false)
                {
                    lock (hidden)
                    {
                        hidden.Add(placeholder.Id);
                        if (blocked == null)
                        {
                            unverified?.Add(placeholder.Id);
                        }
                    }
                }
            }
        }
    }
}
