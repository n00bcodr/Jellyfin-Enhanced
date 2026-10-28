using System;
using System.Threading;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Common ownership of cached facts. A ticket belongs to the input read, not its eventual store. Cache helpers
    /// retain this envelope even for ordinary scalar/DTO values; a transition makes every older envelope a miss.
    /// </summary>
    internal static partial class UserCacheRegistry
    {
        private static long _factsGeneration = 1;
        internal static long FactsGeneration => Volatile.Read(ref _factsGeneration);
        // Only the effective-backend transition owner advances this clock (including observation of legacy saves).
        internal static void AdvanceFactsGeneration() => Interlocked.Increment(ref _factsGeneration);
        private static readonly string ProcessIdentity = Guid.NewGuid().ToString("N");
        internal static string PersistentGeneration => PersistentOrigin(new Ticket(FactsGeneration));
        internal static string PersistentOrigin(Ticket ticket) => ProcessIdentity + ":" + ticket.Generation.ToString(System.Globalization.CultureInfo.InvariantCulture);
        internal static bool ReadPersistedOrigin(string origin)
        {
            var ticket = Begin();
            if (origin != PersistentGeneration || !Current(ticket)) return false;
            try { Use(ticket, tainted: true); }
            catch (Services.Acquire.Backends.BackendDisabledException) { return false; }
            SeerrFacts.MarkCachedTaint();
            return true;
        }
        internal static bool TaintMode { get; set; }
        internal static long TaintedHandouts;
        internal static long TaintedEnvelopeStores;
        internal static long RejectedPlainStores;
        internal static long TaintedStateCaptures;
        internal readonly record struct Ticket(long Generation);
        internal sealed record Entry<T>(Ticket Ticket, T Value, bool Tainted);
        internal static long SampleGeneration()
        {
            // A legacy direct config replacement is observed by the same owner before the first input is read.
            _ = Services.Acquire.Backends.EffectiveRequestsBackend.Shared.Current;
            return FactsGeneration;
        }
        internal static Ticket Begin() => new(Operations.Value?.Generation ?? SeerrFacts.OperationGeneration ?? SampleGeneration());
        internal static Entry<T> Store<T>(Ticket ticket, T value)
        {
            var tainted = SeerrFacts.IsTainted(value);
            if (TaintMode && tainted && value is not SeerrFacts.IDerived)
            {
                Interlocked.Increment(ref RejectedPlainStores);
                throw new InvalidOperationException("A plain cache store lost a Seerr dependency; retain a Derived value.");
            }
            if (TaintMode && tainted) Interlocked.Increment(ref TaintedEnvelopeStores);
            return new(ticket, value, tainted);
        }
        internal static bool Current(Ticket ticket) => ticket.Generation == FactsGeneration
            && (!Services.Acquire.Backends.EffectiveRequestsBackend.Shared.FactsFenced || SeerrFacts.RetainsFacts);
        internal static void Use(Ticket ticket, bool tainted = false)
        {
            if (Operations.Value == null && SeerrFacts.OperationGeneration == null) SampleGeneration();
            if (!Current(ticket) || (Operations.Value?.Generation ?? SeerrFacts.OperationGeneration ?? ticket.Generation) != ticket.Generation)
                throw new Services.Acquire.Backends.BackendDisabledException("configuration_changed");
            SeerrFacts.IncludeCachedGeneration(ticket.Generation, tainted);
        }
        internal static bool TryRead<T>(Entry<T> entry, out T value)
        {
            if (Current(entry.Ticket))
            {
                try { Use(entry.Ticket, entry.Tainted); value = entry.Value; return true; }
                catch (Services.Acquire.Backends.BackendDisabledException) { }
            }
            value = default!;
            return false;
        }
    }
}
