using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// The one way JE keeps something that depends on a Jellyfin user's access across requests: every such cache is this
    /// type (the tests list every cache in the plugin and fail on one keyed by a user that isn't, unless it is listed with
    /// the reason it doesn't depend on access). An entry is served only while
    /// <list type="bullet">
    /// <item><description>the user is the same as when it was computed: for an entry computed from the user as the
    /// request read them (<see cref="Begin(JUser, Guid[])"/>), the same <see cref="UserAuthority.Fingerprint"/> as the
    /// user the asking request read, and the person's own version unchanged (<see cref="UserAuthority.OwnUnchanged"/>);
    /// for an entry that stands for the user itself, where reading them again is the cost the cache saves
    /// (<see cref="BeginHeld"/>), the person's version unchanged (<see cref="UserAuthority.Unchanged"/>);</description></item>
    /// <item><description>nothing invalidated it since its computation BEGAN (<see cref="Invalidate"/>,
    /// <see cref="InvalidateAll"/>; the ticket protocol of <see cref="InvalidationLedger{TRecord}"/>): a computation that ran
    /// across an invalidation (it may have read the state before it) never leaves an entry that is served, even if it is
    /// stored after;</description></item>
    /// <item><description>within its lifetime on the monotonic clock, counted from when its inputs were READ and never
    /// past the deadline of a cache they came through (a bound only for what nothing above sees: a change written straight
    /// into Jellyfin's database by other code).</description></item>
    /// </list>
    /// A value carries the stamp of the inputs it was computed from, never one taken later: the stamp is one read of the
    /// person (<see cref="UserAuthority.Stamp"/>: their version AND when they were read). A held entry is filed under it
    /// (<see cref="GetHeld"/>'s read returns it; <see cref="GetHeldStamped"/> hands it on, with the entry's deadline, to a
    /// value computed from that user), a fingerprint entry under the fingerprint of the very user object it was computed
    /// from (and, given the read, its instant: <see cref="Begin(JUser, UserAuthority.Stamp, Guid[])"/>).
    /// </summary>
    /// <typeparam name="TKey">The key (it includes the user).</typeparam>
    /// <typeparam name="TValue">What is cached.</typeparam>
    internal sealed class UserAccessCache<TKey, TValue>
        where TKey : notnull
    {
        private const int MaxInvalidations = 8192;

        private readonly ConcurrentDictionary<TKey, Entry> _entries = new();
        private readonly TimeSpan _ttl;
        private readonly int _maxEntries;
        private readonly Func<TValue, bool>? _final;
        private readonly Func<long> _ticks = MonotonicClock.Now;
        private readonly Action<string>? _step;
        // (user, scope) → its last invalidation; Guid.Empty as the user: every user's entries of the scope; Guid.Empty as
        // the scope: all of the user's entries.
        private readonly InvalidationLedger<(Guid User, Guid Scope)> _ledger;

        /// <summary>Creates the cache.</summary>
        /// <param name="ttl">How long an entry may be served at most, from when its inputs were read.</param>
        /// <param name="maxEntries">How many entries are kept at most.</param>
        /// <param name="final">Values no change to the user can alter (no such user: Jellyfin never reuses an id), served
        /// within the lifetime without the user check.</param>
        public UserAccessCache(TimeSpan ttl, int maxEntries, Func<TValue, bool>? final = null)
            : this(ttl, maxEntries, final, MaxInvalidations, null)
        {
        }

        /// <summary>Creates the cache with a record bound and a hook at each point another thread can interleave (tests).</summary>
        /// <param name="ttl">How long an entry may be served at most, from when its inputs were read.</param>
        /// <param name="maxEntries">How many entries are kept at most.</param>
        /// <param name="final">Values served within the lifetime without the user check.</param>
        /// <param name="maxInvalidations">How many invalidation records are kept before a rollover.</param>
        /// <param name="step">Called at each interleaving point ("invalidate", "swap", "store").</param>
        internal UserAccessCache(TimeSpan ttl, int maxEntries, Func<TValue, bool>? final, int maxInvalidations, Action<string>? step)
        {
            _ttl = ttl;
            _maxEntries = Math.Max(1, maxEntries);
            _final = final;
            _step = step;
            _ledger = new InvalidationLedger<(Guid User, Guid Scope)>(maxInvalidations, null, step);
        }

        /// <summary>What an entry is computed for, taken BEFORE computing it.</summary>
        public readonly struct Ticket
        {
            internal Ticket(Guid user, string? authority, UserAuthority.Stamp stamp, long clock, long ticks, long until, Guid[] scopes)
            {
                User = user;
                Authority = authority;
                Stamp = stamp;
                Clock = clock;
                Ticks = ticks;
                Until = until;
                Scopes = scopes;
            }

            /// <summary>The user.</summary>
            public Guid User { get; }

            /// <summary>The user's fingerprint as the request read them; null for an entry that stands for the user itself.</summary>
            public string? Authority { get; }

            internal UserAuthority.Stamp Stamp { get; }

            internal long Clock { get; }

            // When the inputs were read: the lifetime counts from here, not from when the value is stored.
            internal long Ticks { get; }

            // The latest the inputs may be served (a cache they came through ends them then).
            internal long Until { get; }

            internal Guid[] Scopes { get; }

            internal long Deadline(TimeSpan ttl) => Math.Min(Until, Ticks + ttl.Ticks);
        }

        private sealed record Entry(TValue Value, long ExpiresAt, Ticket Ticket);

        /// <summary>Entries held (valid or not yet dropped).</summary>
        public int Count => _entries.Count;

        /// <summary>
        /// A ticket for an entry computed from <paramref name="user"/> as this request read them: filed under their
        /// fingerprint (taken from this very object, so it is the input's own stamp); the person's version now and the
        /// invalidation clock now only END it later (a change after this point), never vouch for it. Its lifetime runs
        /// from now; given the read, use <see cref="Begin(JUser, UserAuthority.Stamp, Guid[])"/>.
        /// </summary>
        /// <param name="user">The user, as just read.</param>
        /// <param name="scopes">What else the entry depends on that <see cref="Invalidate"/> names (a season, a series).</param>
        /// <returns>The ticket.</returns>
        public Ticket Begin(JUser user, params Guid[] scopes)
        {
            var now = _ticks();
            return new(user.Id, UserAuthority.Fingerprint(user), UserAuthority.Take(user.Id), _ledger.Begin(), now, long.MaxValue, scopes);
        }

        /// <summary>
        /// <see cref="Begin(JUser, Guid[])"/> for a user whose read is at hand (<paramref name="read"/>, from
        /// <see cref="UserAuthority.ReadOncePerRequest"/>): the lifetime runs from that read, not from now.
        /// </summary>
        /// <param name="user">The user, as read under <paramref name="read"/>.</param>
        /// <param name="read">The read's stamp.</param>
        /// <param name="scopes">What else the entry depends on that <see cref="Invalidate"/> names.</param>
        /// <returns>The ticket.</returns>
        public Ticket Begin(JUser user, UserAuthority.Stamp read, params Guid[] scopes)
            => new(user.Id, UserAuthority.Fingerprint(user), UserAuthority.Take(user.Id), _ledger.Begin(), Math.Min(read.ReadAt, _ticks()), read.Until, scopes);

        /// <summary>
        /// A ticket for an entry that stands for the user itself (the user, or an answer read through a cache of the user):
        /// checked by the person's version alone, so <paramref name="stamp"/> must be the one the user was READ under; its
        /// lifetime runs from that read and ends no later than the stamp's deadline.
        /// </summary>
        /// <param name="userId">The user.</param>
        /// <param name="stamp">The read the user came from (<see cref="UserAuthority.ReadOncePerRequest"/> returns it).</param>
        /// <param name="scopes">What else the entry depends on that <see cref="Invalidate"/> names.</param>
        /// <returns>The ticket.</returns>
        public Ticket BeginHeld(Guid userId, UserAuthority.Stamp stamp, params Guid[] scopes)
            => Held(userId, stamp, _ledger.Begin(), scopes);

        private Ticket Held(Guid userId, UserAuthority.Stamp stamp, long clock, Guid[] scopes)
            => new(userId, null, stamp, clock, Math.Min(stamp.ReadAt, _ticks()), stamp.Until, scopes);

        /// <summary>
        /// For a cache that stands for the user itself: the entry for <paramref name="key"/> while the person's version
        /// is unchanged, else <paramref name="read"/> (which returns the read its user came from) kept under that read and
        /// the invalidation clock taken before it ran.
        /// </summary>
        /// <param name="key">The key.</param>
        /// <param name="userId">The user.</param>
        /// <param name="read">Reads the value and the stamp of the read its user came from.</param>
        /// <param name="scopes">What else the entry depends on that <see cref="Invalidate"/> names.</param>
        /// <returns>The value.</returns>
        public TValue GetHeld(TKey key, Guid userId, Func<(TValue Value, UserAuthority.Stamp Stamp)> read, params Guid[] scopes)
            => GetHeldStamped(key, userId, read, scopes).Value;

        /// <summary>
        /// <see cref="GetHeld"/> with the read the value's user came from (the entry's, on a hit), carrying the entry's
        /// deadline: what a value computed from this one must be filed under in turn, so it never outlives this entry.
        /// </summary>
        /// <param name="key">The key.</param>
        /// <param name="userId">The user.</param>
        /// <param name="read">Reads the value and the stamp of the read its user came from.</param>
        /// <param name="scopes">What else the entry depends on that <see cref="Invalidate"/> names.</param>
        /// <returns>The value and its stamp.</returns>
        public (TValue Value, UserAuthority.Stamp Stamp) GetHeldStamped(TKey key, Guid userId, Func<(TValue Value, UserAuthority.Stamp Stamp)> read, params Guid[] scopes)
        {
            if (_entries.TryGetValue(key, out var entry) && Serves(entry, null, _ticks())) return (entry.Value, entry.Ticket.Stamp.Within(entry.ExpiresAt));
            var clock = _ledger.Begin();
            var (value, stamp) = read();
            var ticket = Held(userId, stamp, clock, scopes);
            Set(key, ticket, value);
            return (value, stamp.Within(ticket.Deadline(_ttl)));
        }

        /// <summary>The entry for <paramref name="key"/>, when it may still be served to a request whose user, as it read
        /// them, has <paramref name="authority"/> (null: an entry that stands for the user itself).</summary>
        /// <param name="key">The key.</param>
        /// <param name="authority">The asking request's ticket's <see cref="Ticket.Authority"/>.</param>
        /// <param name="value">The value.</param>
        /// <returns>True when served.</returns>
        public bool TryGet(TKey key, string? authority, out TValue value)
        {
            if (_entries.TryGetValue(key, out var entry) && Serves(entry, authority, _ticks()))
            {
                value = entry.Value;
                return true;
            }

            value = default!;
            return false;
        }

        /// <summary>Keeps <paramref name="value"/>, computed after <paramref name="ticket"/> was taken (not kept when
        /// something already invalidated it).</summary>
        /// <param name="key">The key.</param>
        /// <param name="ticket">The ticket taken before computing.</param>
        /// <param name="value">The value.</param>
        public void Set(TKey key, in Ticket ticket, TValue value)
        {
            var now = _ticks();
            var entry = new Entry(value, ticket.Deadline(_ttl), ticket);
            if (!Serves(entry, ticket.Authority, now)) return;
            _step?.Invoke("store");
            if (_entries.Count >= _maxEntries)
            {
                foreach (var held in _entries.ToArray())
                {
                    if (!Serves(held.Value, held.Value.Ticket.Authority, now)) _entries.TryRemove(held.Key, out _);
                }

                // Still full of live entries: start over (each refills at one computation per active key).
                if (_entries.Count >= _maxEntries) _entries.Clear();
            }

            _entries[key] = entry;
        }

        /// <summary>
        /// Ends every entry of <paramref name="userId"/> that depends on <paramref name="scope"/>, and every one whose
        /// computation is running now. <see cref="Guid.Empty"/> as the user: every user's; as the scope: all of the
        /// user's entries.
        /// </summary>
        /// <param name="userId">The user, or <see cref="Guid.Empty"/>.</param>
        /// <param name="scope">The scope, or <see cref="Guid.Empty"/>.</param>
        public void Invalidate(Guid userId, Guid scope = default)
        {
            if (userId == Guid.Empty && scope == Guid.Empty)
            {
                InvalidateAll();
                return;
            }

            // Too many records: every entry begun before any of them ended instead.
            if (_ledger.Invalidate((userId, scope))) _entries.Clear();
        }

        /// <summary>Ends every entry, and every one whose computation is running now.</summary>
        public void InvalidateAll()
        {
            _ledger.InvalidateAll();
            _entries.Clear();
        }

        private bool Serves(Entry entry, string? authority, long now)
        {
            var ticket = entry.Ticket;
            // One epoch for every check: its records and floor are from the same moment.
            var epoch = _ledger.Current;
            if (entry.ExpiresAt <= now || !epoch.Admits(ticket.Clock)) return false;
            if (epoch.Ended((ticket.User, Guid.Empty), ticket.Clock)) return false;
            foreach (var scope in ticket.Scopes)
            {
                if (scope != Guid.Empty && (epoch.Ended((ticket.User, scope), ticket.Clock) || epoch.Ended((Guid.Empty, scope), ticket.Clock))) return false;
            }

            if (_final != null && _final(entry.Value)) return true;
            if (ticket.Authority == null)
            {
                return authority == null && UserAuthority.Unchanged(ticket.User, ticket.Stamp);
            }

            return string.Equals(ticket.Authority, authority, StringComparison.Ordinal) && UserAuthority.OwnUnchanged(ticket.User, ticket.Stamp);
        }
    }
}
