using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;

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
    /// <see cref="InvalidateAll"/>): the ticket is taken before computing, so a computation that ran across an invalidation
    /// (it may have read the state before it) never leaves an entry that is served, even if it is stored after;</description></item>
    /// <item><description>within its lifetime (a bound only for what nothing above sees: a change written straight into
    /// Jellyfin's database by other code).</description></item>
    /// </list>
    /// </summary>
    /// <typeparam name="TKey">The key (it includes the user).</typeparam>
    /// <typeparam name="TValue">What is cached.</typeparam>
    internal sealed class UserAccessCache<TKey, TValue>
        where TKey : notnull
    {
        private const int MaxInvalidations = 8192;

        private readonly ConcurrentDictionary<TKey, Entry> _entries = new();
        // (user, scope) → the clock value of its last invalidation; Guid.Empty as the user: every user's entries of the
        // scope; Guid.Empty as the scope: all of the user's entries.
        private readonly ConcurrentDictionary<(Guid User, Guid Scope), long> _invalidated = new();
        private readonly TimeSpan _ttl;
        private readonly int _maxEntries;
        private readonly Func<TValue, bool>? _final;
        private readonly Func<long> _ticks;
        private long _clock;
        // Entries begun before it are never served (InvalidateAll, or the invalidation records were cleared).
        private long _floor;

        /// <summary>Creates the cache.</summary>
        /// <param name="ttl">How long an entry may be served at most.</param>
        /// <param name="maxEntries">How many entries are kept at most.</param>
        /// <param name="final">Values no change to the user can alter (no such user: Jellyfin never reuses an id), served
        /// within the lifetime without the user check.</param>
        /// <param name="ticks">The clock, in ticks (tests).</param>
        public UserAccessCache(TimeSpan ttl, int maxEntries, Func<TValue, bool>? final = null, Func<long>? ticks = null)
        {
            _ttl = ttl;
            _maxEntries = Math.Max(1, maxEntries);
            _final = final;
            _ticks = ticks ?? (() => DateTime.UtcNow.Ticks);
        }

        /// <summary>What an entry is computed for, taken BEFORE computing it.</summary>
        public readonly struct Ticket
        {
            internal Ticket(Guid user, string? authority, UserAuthority.Stamp stamp, long clock, Guid[] scopes)
            {
                User = user;
                Authority = authority;
                Stamp = stamp;
                Clock = clock;
                Scopes = scopes;
            }

            /// <summary>The user.</summary>
            public Guid User { get; }

            /// <summary>The user's fingerprint as the request read them; null for an entry that stands for the user itself.</summary>
            public string? Authority { get; }

            internal UserAuthority.Stamp Stamp { get; }

            internal long Clock { get; }

            internal Guid[] Scopes { get; }
        }

        private sealed record Entry(TValue Value, long ExpiresAt, Ticket Ticket);

        /// <summary>Entries held (valid or not yet dropped).</summary>
        public int Count => _entries.Count;

        /// <summary>
        /// A ticket for an entry computed from <paramref name="user"/> as this request read them: their fingerprint, the
        /// person's version now and the invalidation clock now.
        /// </summary>
        /// <param name="user">The user, as just read.</param>
        /// <param name="scopes">What else the entry depends on that <see cref="Invalidate"/> names (a season, a series).</param>
        /// <returns>The ticket.</returns>
        public Ticket Begin(JUser user, params Guid[] scopes)
            => new(user.Id, UserAuthority.Fingerprint(user), UserAuthority.Take(user.Id), Interlocked.Read(ref _clock), scopes);

        /// <summary>
        /// A ticket for an entry that stands for the user itself (the user, or an answer read through a cache of the user):
        /// checked by the person's version alone.
        /// </summary>
        /// <param name="userId">The user.</param>
        /// <param name="stamp">The person's version, taken before the user was read (<see cref="UserAuthority.ReadOncePerRequest"/>
        /// returns it), or <see cref="UserAuthority.Take"/> now.</param>
        /// <param name="scopes">What else the entry depends on that <see cref="Invalidate"/> names.</param>
        /// <returns>The ticket.</returns>
        public Ticket BeginHeld(Guid userId, UserAuthority.Stamp stamp, params Guid[] scopes)
            => new(userId, null, stamp, Interlocked.Read(ref _clock), scopes);

        /// <summary>
        /// For a cache that stands for the user itself: the entry for <paramref name="key"/> while the person's version
        /// is unchanged, else <paramref name="read"/> (which returns the person's version taken before it read the user)
        /// kept under the invalidation clock taken before it ran.
        /// </summary>
        /// <param name="key">The key.</param>
        /// <param name="userId">The user.</param>
        /// <param name="read">Reads the value and the stamp taken before.</param>
        /// <param name="scopes">What else the entry depends on that <see cref="Invalidate"/> names.</param>
        /// <returns>The value.</returns>
        public TValue GetHeld(TKey key, Guid userId, Func<(TValue Value, UserAuthority.Stamp Stamp)> read, params Guid[] scopes)
        {
            if (TryGet(key, null, out var hit)) return hit;
            var clock = Interlocked.Read(ref _clock);
            var (value, stamp) = read();
            Set(key, new Ticket(userId, null, stamp, clock, scopes), value);
            return value;
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
            var entry = new Entry(value, now + _ttl.Ticks, ticket);
            if (!Serves(entry, ticket.Authority, now)) return;
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

            if (_invalidated.Count >= MaxInvalidations)
            {
                // Too many records: every entry begun so far ends instead.
                InvalidateAll();
                _invalidated.Clear();
                return;
            }

            var at = Interlocked.Increment(ref _clock);
            _invalidated.AddOrUpdate((userId, scope), at, (_, was) => Math.Max(was, at));
        }

        /// <summary>Ends every entry, and every one whose computation is running now.</summary>
        public void InvalidateAll()
        {
            var at = Interlocked.Increment(ref _clock);
            long floor;
            do
            {
                floor = Interlocked.Read(ref _floor);
                if (floor >= at) break;
            }
            while (Interlocked.CompareExchange(ref _floor, at, floor) != floor);
            _entries.Clear();
        }

        private bool Serves(Entry entry, string? authority, long now)
        {
            var ticket = entry.Ticket;
            if (entry.ExpiresAt <= now || ticket.Clock < Interlocked.Read(ref _floor)) return false;
            if (Ended(ticket.User, Guid.Empty, ticket.Clock)) return false;
            foreach (var scope in ticket.Scopes)
            {
                if (scope != Guid.Empty && (Ended(ticket.User, scope, ticket.Clock) || Ended(Guid.Empty, scope, ticket.Clock))) return false;
            }

            if (_final != null && _final(entry.Value)) return true;
            if (ticket.Authority == null)
            {
                return authority == null && UserAuthority.Unchanged(ticket.User, ticket.Stamp);
            }

            return string.Equals(ticket.Authority, authority, StringComparison.Ordinal) && UserAuthority.OwnUnchanged(ticket.User, ticket.Stamp);
        }

        // Invalidated after a computation that began at clock.
        private bool Ended(Guid user, Guid scope, long clock) => _invalidated.TryGetValue((user, scope), out var at) && at > clock;
    }
}
