using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>What a Jellyfin write does to a list.</summary>
    public enum ListWriteKind
    {
        /// <summary>Creates a playlist or collection.</summary>
        Create,

        /// <summary>Puts items into a playlist (as its owner).</summary>
        Insert,

        /// <summary>Moves a playlist row as the person who asked (a native editor) or, without native rights, the owner.</summary>
        Move,

        /// <summary>Moves rows JE just put into a playlist into place (Jellyfin 10.11), as the owner.</summary>
        Place,

        /// <summary>Puts items into a collection.</summary>
        CollectionAdd,

        /// <summary>Gives a list JE just created the name the person chose (it was created under a name carrying its marker).</summary>
        FinishCreate,
    }

    /// <summary>
    /// One Jellyfin write, allowed by <see cref="ListGate"/> right before it: the list it is for and the user it runs as
    /// (a playlist's current owner, never a parameter of the write). Spent by the write; a second use throws.
    /// </summary>
    public sealed class ListWrite
    {
        private int _spent;

        internal ListWrite(Guid listId, Guid actAs, ListWriteKind kind)
        {
            ListId = listId;
            ActAs = actAs;
            Kind = kind;
        }

        /// <summary>The list (empty for a create).</summary>
        public Guid ListId { get; }

        /// <summary>The user Jellyfin's write runs as.</summary>
        public Guid ActAs { get; }

        /// <summary>What the write does.</summary>
        public ListWriteKind Kind { get; }

        /// <summary>Uses the grant for a write to <paramref name="listId"/>: once, and only for the list it was made for.</summary>
        /// <param name="listId">The list being written.</param>
        /// <param name="kind">What the write does.</param>
        public void Spend(Guid listId, ListWriteKind kind)
        {
            // Inside a create or swap continuation, the write also needs its operation and list as they are now.
            ListContinuation.Ensure();
            // A move grant also covers placing rows JE just inserted (both are Jellyfin moves).
            if (listId != ListId || !(kind == Kind || (kind == ListWriteKind.Move && Kind == ListWriteKind.Place)))
            {
                throw new InvalidOperationException($"A {Kind} grant for list {ListId:N} can't be used for a {kind} of {listId:N}.");
            }

            if (Interlocked.Exchange(ref _spent, 1) != 0)
            {
                throw new InvalidOperationException("A list write grant was used twice.");
            }
        }
    }

    /// <summary>A caller's access to a list as the gate read it right before an answer, and what they may see of it.</summary>
    internal sealed class ListGrant
    {
        internal ListGrant(ListAccess access, PlaceholderVisibility visibility, string policy)
        {
            Access = access;
            Visibility = visibility;
            Policy = policy;
        }

        /// <summary>The caller's current access.</summary>
        public ListAccess Access { get; }

        /// <summary>The placeholders they may see, checked against their current limits.</summary>
        public PlaceholderVisibility Visibility { get; }

        /// <summary>
        /// The caller's policy revision when the grant was made (<see cref="ListGate.Policy"/>): anything composed for them
        /// earlier under another revision (statuses) is not theirs to see now.
        /// </summary>
        public string Policy { get; }
    }

    /// <summary>The gate refused a write: what to answer (null for background work, which just stops).</summary>
    internal class ListAccessLostException : Exception
    {
        public ListAccessLostException(ListOutcome? outcome, string message)
            : base(message)
        {
            Outcome = outcome;
        }

        public ListOutcome? Outcome { get; }
    }

    /// <summary>
    /// The one list access gate. Everything about who may do what with a list is read here, at the moment it matters:
    /// the person (read again: a removed share, a new limit, lost collection management, being disabled count), the list
    /// as Jellyfin has it now (owner, shares, public), the owner a playlist write runs as, the list's swap-in consent, which placeholders
    /// the person's parental limits let them see and which items they and the owner can open. Called right before every
    /// Jellyfin write (<see cref="Write"/>, <see cref="SwapWrite"/>, <see cref="CreateWrite"/>, whose
    /// <see cref="ListWrite"/> the write takes as its first argument) and before every answer with list contents
    /// (<see cref="ProjectAsync{T}"/>, which builds the answer itself, synchronously, from what it just checked). No
    /// await sits between a check and what it allows.
    /// </summary>
    public sealed class ListGate
    {
        private const int ProjectionAttempts = 3;

        private readonly IListHost _host;
        private readonly IUserManager _users;
        private readonly ListAccessService _access;

        internal ListGate(IListHost host, IUserManager users, ListAccessService access)
        {
            _host = host;
            _users = users;
            _access = access;
        }

        // ── People ───────────────────────────────────────────────────────────

        /// <summary>
        /// The caller's access to the list now: the person read again and the list as Jellyfin has it now. Null when the
        /// person or the list is gone, the person is disabled or they can no longer see it.
        /// </summary>
        /// <param name="access">The access checked earlier.</param>
        /// <returns>The current access, or null.</returns>
        public ListAccess? Current(ListAccess access)
        {
            var user = Active(access.User.Id);
            var current = user == null ? null : _access.Resolve(access.List.Id, user);
            return current is { Permissions.CanView: true } ? current : null;
        }

        /// <summary>
        /// A person's policy revision: everything about them that decides what they may see or do (role, disabled,
        /// collection management, library access, parental limits). Equal revisions decide the same things.
        /// </summary>
        /// <param name="user">The person (as just read).</param>
        /// <returns>The revision.</returns>
        internal string Policy(User user) => _access.PolicyStamp(user);

        /// <summary>The caller's right to change the list now: 404 when they can't see it, 403 when they can't edit it.</summary>
        /// <param name="access">The access checked earlier.</param>
        /// <returns>The refusal, or the current access.</returns>
        internal (ListOutcome? Denied, ListAccess? Current) Edit(ListAccess access)
        {
            var current = Current(access);
            if (current == null)
            {
                return (NotFound(), null);
            }

            return current.Permissions.CanEdit ? (null, current) : (Forbidden(), null);
        }

        /// <summary>
        /// A person's Jellyfin write, allowed now or refused with <see cref="ListAccessLostException"/>: they can still edit
        /// the list; a playlist insert (or placing what it inserted) runs as the playlist's current owner and every item is
        /// one both of them can open; a move runs as the person when they edit natively (else the owner) and the row is
        /// one both see; a collection add holds items the person can open.
        /// </summary>
        /// <param name="access">The access checked earlier.</param>
        /// <param name="kind">What the write does.</param>
        /// <param name="items">The items it writes.</param>
        /// <returns>The single-use grant.</returns>
        internal ListWrite Write(ListAccess access, ListWriteKind kind, IReadOnlyCollection<Guid> items)
        {
            var (denied, current) = Edit(access);
            if (denied != null)
            {
                throw new ListAccessLostException(denied, "The caller can't edit the list any more.");
            }

            var user = current!.User;
            if (kind == ListWriteKind.CollectionAdd)
            {
                Require(items.All(id => _host.CanAccessItem(id, user)), "An item the caller can't open any more.");
                return new ListWrite(current.List.Id, user.Id, kind);
            }

            var mover = kind == ListWriteKind.Move && current.Permissions.NativeCanEdit ? user : current.Owner;
            if (mover == null || mover.HasPermission(PermissionKind.IsDisabled))
            {
                // The owner the write would run as is gone or disabled: nothing runs as them.
                throw new ListAccessLostException(ListOutcome.Error(409, "owner_missing", "The playlist owner no longer exists or is disabled."), "The playlist has no usable owner.");
            }

            if (kind is ListWriteKind.Move or ListWriteKind.Place)
            {
                Require(items.All(id => _host.IsEntryVisible(id, mover) && (kind == ListWriteKind.Place || _host.IsEntryVisible(id, user))), "A row the caller or owner can't see any more.");
            }
            else
            {
                Require(items.All(id => _host.CanAccessItem(id, user) && _host.CanAccessItem(id, mover)), "An item the caller or owner can't open any more.");
            }

            return new ListWrite(current.List.Id, mover.Id, kind);
        }

        /// <summary>
        /// A person's create, allowed now or refused with <see cref="ListAccessLostException"/>: the person still exists, isn't
        /// disabled and, for a collection, may still manage collections.
        /// </summary>
        /// <param name="user">The person.</param>
        /// <param name="kind">List kind.</param>
        /// <returns>The single-use grant (runs as the person).</returns>
        internal ListWrite CreateWrite(User user, string kind)
        {
            var fresh = Person(user.Id, kind) ?? throw new ListAccessLostException(CreateRefusal(user.Id), "The person can't create this list any more.");
            return new ListWrite(Guid.Empty, fresh.Id, ListWriteKind.Create);
        }

        /// <summary>
        /// Giving a list the person just created its chosen name, allowed now or refused with
        /// <see cref="ListAccessLostException"/>: they may still create a list of its kind; the list, read again, is one
        /// they can still see and edit (a create recovered after a crash may find it hidden from them by then: 404); and, for
        /// a playlist, they still own it (the rename runs as them).
        /// </summary>
        /// <param name="list">The list the create made.</param>
        /// <param name="user">The person who created it.</param>
        /// <returns>The single-use grant.</returns>
        internal ListWrite FinishWrite(ListInfo list, User user)
        {
            var fresh = Person(user.Id, list.Kind) ?? throw new ListAccessLostException(CreateRefusal(user.Id), "The person can't create this list any more.");
            var current = _access.Resolve(list.Id, fresh);
            if (current is not { Permissions.CanView: true, Permissions.CanEdit: true } || current.List.Kind != list.Kind)
            {
                throw new ListAccessLostException(NotFound(), "The person can't see or edit the list any more.");
            }

            if (current.List.Kind == ListKinds.Playlist && current.List.OwnerId != fresh.Id)
            {
                throw new ListAccessLostException(NotFound(), "The playlist isn't the person's any more.");
            }

            return new ListWrite(current.List.Id, fresh.Id, ListWriteKind.FinishCreate);
        }

        /// <summary>
        /// The person read again, when they may still create a list of this kind: they exist, aren't disabled and, for a
        /// collection, may manage collections.
        /// </summary>
        /// <param name="userId">The person.</param>
        /// <param name="kind">List kind.</param>
        /// <returns>The person, or null.</returns>
        internal User? Person(Guid userId, string kind)
        {
            var fresh = Active(userId);
            return fresh == null || (kind == ListKinds.Collection && !ListAccessService.CanManageCollections(fresh)) ? null : fresh;
        }

        /// <summary>Why a person may not create a list now: gone or disabled (403 user_required), else no collection management.</summary>
        /// <param name="userId">The person.</param>
        /// <returns>The refusal.</returns>
        internal ListOutcome CreateRefusal(Guid userId) => Active(userId) == null
            ? ListOutcome.Error(403, "user_required", "Sign in as a person to use lists.")
            : Forbidden("You can't manage collections.");

        // The person read again; null when they are gone or disabled.
        private User? Active(Guid userId)
        {
            var user = _users.GetUserById(userId);
            return user == null || user.HasPermission(PermissionKind.IsDisabled) ? null : user;
        }

        // ── Swap-in (the list's recorded consent, no person's request) ──────

        /// <summary>
        /// A swap-in write, allowed now or refused with <see cref="ListAccessLostException"/> (no outcome: the pass just
        /// stops inserting): the list's consent holds on the list as Jellyfin has it now; a playlist write runs as the
        /// owner the pass resolved its items for, who is still the playlist's owner, exists, is enabled and can open
        /// every item (rows to move: sees them); and, for a swap-in a person's request started, that person can still
        /// edit the list.
        /// </summary>
        /// <param name="listId">The list.</param>
        /// <param name="doc">Its document (the recorded consent).</param>
        /// <param name="owner">The owner the pass works for (playlists).</param>
        /// <param name="kind">What the write does.</param>
        /// <param name="items">The items it writes.</param>
        /// <param name="consent">The list's consent rule (<see cref="ListSwapService.InsertsAllowed"/>).</param>
        /// <param name="onBehalfOf">The person whose request started the swap-in, or null.</param>
        /// <returns>The single-use grant.</returns>
        internal ListWrite SwapWrite(Guid listId, ListDoc doc, User? owner, ListWriteKind kind, IReadOnlyCollection<Guid> items, Func<ListInfo, ListDoc, bool> consent, ListAccess? onBehalfOf = null)
        {
            if (!SwapAllowed(listId, doc, owner, kind, items, consent, onBehalfOf, out var actAs))
            {
                throw new ListAccessLostException(null, "Swap-in isn't allowed for this list any more.");
            }

            return new ListWrite(listId, actAs, kind);
        }

        /// <summary>Whether a swap-in write would be allowed now (see <see cref="SwapWrite"/>), without making a grant.</summary>
        /// <param name="listId">The list.</param>
        /// <param name="doc">Its document.</param>
        /// <param name="owner">The owner the pass works for.</param>
        /// <param name="kind">What the write does.</param>
        /// <param name="items">The items it writes.</param>
        /// <param name="consent">The list's consent rule.</param>
        /// <param name="onBehalfOf">The person whose request started the swap-in, or null.</param>
        /// <returns>Whether it is allowed.</returns>
        internal bool SwapAllowed(Guid listId, ListDoc doc, User? owner, ListWriteKind kind, IReadOnlyCollection<Guid> items, Func<ListInfo, ListDoc, bool> consent, ListAccess? onBehalfOf)
            => SwapAllowed(listId, doc, owner, kind, items, consent, onBehalfOf, out _);

        private bool SwapAllowed(Guid listId, ListDoc doc, User? owner, ListWriteKind kind, IReadOnlyCollection<Guid> items, Func<ListInfo, ListDoc, bool> consent, ListAccess? onBehalfOf, out Guid actAs)
        {
            actAs = Guid.Empty;
            var list = _host.GetList(listId);
            if (list == null || !consent(list, doc) || (onBehalfOf != null && Current(onBehalfOf) is not { Permissions.CanEdit: true }))
            {
                return false;
            }

            if (list.Kind == ListKinds.Collection)
            {
                return items.All(id => _host.GetItem(id) != null);
            }

            var current = owner == null || list.OwnerId != owner.Id ? null : Active(owner.Id);
            if (current == null)
            {
                return false;
            }

            actAs = current.Id;
            return kind is ListWriteKind.Move or ListWriteKind.Place
                ? items.All(id => _host.IsEntryVisible(id, current))
                : items.All(id => _host.CanAccessItem(id, current));
        }

        // ── Answers ──────────────────────────────────────────────────────────

        /// <summary>
        /// Builds an answer with list contents for the caller as they may see it right now: their access is read again,
        /// the placeholders checked against their current limits (<paramref name="known"/> is used when it was checked
        /// against the same limits, else they are checked again), their access read once more and the answer built by
        /// <paramref name="build"/> at once, with no await in between. Null when they can no longer see the list (or their
        /// limits kept changing while they were checked: fail closed).
        /// </summary>
        /// <typeparam name="T">Answer type.</typeparam>
        /// <param name="access">The access checked earlier.</param>
        /// <param name="items">The placeholders the answer may show.</param>
        /// <param name="known">A visibility already checked (reused when the limits are unchanged), or null.</param>
        /// <param name="build">Builds the answer from the current access and visibility (synchronous).</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The answer, or null.</returns>
        internal async Task<T?> ProjectAsync<T>(ListAccess access, IReadOnlyList<Placeholder> items, PlaceholderVisibility? known, Func<ListGrant, T> build, CancellationToken cancellationToken)
            where T : class
        {
            for (var attempt = 0; attempt < ProjectionAttempts; attempt++)
            {
                if (Current(access) is not { } current)
                {
                    return null;
                }

                var publication = _access.CapturePublication();
                var visibility = known != null && known.Matches(_access.ParentalStamp(current.User))
                    ? known
                    : await ListContinuation.Await(() => VisibilityAsync(items, current.User, cancellationToken)).ConfigureAwait(false);
                if (Current(access) is not { } final)
                {
                    return null;
                }

                if (visibility.Matches(_access.ParentalStamp(final.User)))
                {
                    return publication.Publish(() => build(new ListGrant(final, visibility, Policy(final.User))));
                }

                known = null;
            }

            return null;
        }

        /// <summary>
        /// The caller's current access with a visibility checked against their current limits, for work that acts entry
        /// by entry (each ask of a confirmation): use it at once, with no await before the effect it allows.
        /// </summary>
        /// <param name="access">The access checked earlier.</param>
        /// <param name="items">The placeholders concerned.</param>
        /// <param name="known">A visibility already checked, or null.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The grant, or null when the caller can no longer see the list.</returns>
        internal Task<ListGrant?> GrantAsync(ListAccess access, IReadOnlyList<Placeholder> items, PlaceholderVisibility? known, CancellationToken cancellationToken)
            => ProjectAsync<ListGrant>(access, items, known, grant => grant, cancellationToken);

        /// <summary>
        /// Which placeholders a user may see (A2/C5). Unrestricted users see everything. Restricted users get an
        /// ALLOWLIST of the placeholders checked against their parental filter, bound to the checked title or author and to
        /// the limits it was checked with (<see cref="PlaceholderVisibility.Matches"/>).
        /// </summary>
        /// <param name="items">Placeholders.</param>
        /// <param name="user">Viewer.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The visibility.</returns>
        internal async Task<PlaceholderVisibility> VisibilityAsync(IReadOnlyList<Placeholder> items, User user, CancellationToken cancellationToken)
        {
            var stamp = _access.ParentalStamp(user);
            if (!_access.IsRestricted(user))
            {
                return PlaceholderVisibility.Unrestricted(stamp);
            }

            var hidden = await ListContinuation.Await(() => _access.GetHiddenPlaceholderIdsAsync(items, user, cancellationToken)).ConfigureAwait(false);
            return PlaceholderVisibility.Allowlist(items.Where(p => !hidden.Contains(p.Id)), stamp);
        }

        private static void Require(bool allowed, string message)
        {
            if (!allowed)
            {
                throw new ListAccessLostException(ListOutcome.Error(409, "access_changed", "Who can see the list or its items changed; reload it."), message);
            }
        }

        private static ListOutcome NotFound() => ListOutcome.Error(404, "not_found", "List not found.");

        private static ListOutcome Forbidden(string message = "You can't edit this list.") => ListOutcome.Error(403, "forbidden", message);
    }
}
