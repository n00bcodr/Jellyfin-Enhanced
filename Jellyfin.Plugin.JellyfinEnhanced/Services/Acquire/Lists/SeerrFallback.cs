using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>What one Seerr server's answer to a read was (review round 9, D53: one fallback table for every multi-server read).</summary>
    internal enum ServerState
    {
        /// <summary>A whole answer to the request: used, and nothing more is asked.</summary>
        Valid,

        /// <summary>Usable but incomplete: kept as the fallback (never cached), and the next server is asked.</summary>
        Partial,

        /// <summary>Not an answer JE can read (or another resource's): the next server is asked.</summary>
        Malformed,

        /// <summary>A 5xx, a timeout or a transport failure: the next server is asked; never an absence.</summary>
        Unavailable,

        /// <summary>An affirmative 404: the next server is asked; an absence only when every server says so.</summary>
        NotFound,
    }

    /// <summary>The outcome of a read over every server.</summary>
    internal enum FallbackState
    {
        /// <summary>A server answered in full.</summary>
        Valid,

        /// <summary>No server answered in full; the first partial answer (never cached).</summary>
        Partial,

        /// <summary>Every server affirmatively said there is no such resource.</summary>
        NotFound,

        /// <summary>Anything else: unknown (never an absence, never cached as one).</summary>
        Unavailable,
    }

    /// <summary>One server's answer.</summary>
    /// <typeparam name="T">The answer's value.</typeparam>
    /// <param name="State">What the answer was.</param>
    /// <param name="Value">The value (Valid and Partial).</param>
    /// <param name="Error">Why it failed (Malformed, Unavailable), for the caller's own error report.</param>
    internal readonly record struct ServerAnswer<T>(ServerState State, T? Value = default, Exception? Error = null);

    /// <summary>A read over every server.</summary>
    /// <typeparam name="T">The answer's value.</typeparam>
    /// <param name="State">The outcome.</param>
    /// <param name="Value">The value used (Valid, Partial).</param>
    /// <param name="Servers">Each server's state, in the order asked.</param>
    /// <param name="FirstError">The first failure's error (Malformed or Unavailable), if any.</param>
    internal readonly record struct FallbackResult<T>(FallbackState State, T? Value, IReadOnlyList<ServerState> Servers, Exception? FirstError);

    /// <summary>
    /// THE fallback table of every multi-server (Seerr) read of the lists area (review round 9, D53; 4c2-R9-7): the import
    /// lookups (details, season, search), the placeholder metadata (movie, show, season) and the list-source fallback
    /// (collections, trending, upcoming). Per server, in the configured order:
    /// <list type="bullet">
    /// <item>Valid → use it and stop;</item>
    /// <item>Partial → remember the first as the fallback (never cached), and ask the next;</item>
    /// <item>Malformed → ask the next;</item>
    /// <item>Unavailable (5xx, timeout, transport) → ask the next; never an absence;</item>
    /// <item>NotFound (an affirmative 404) → ask the next.</item>
    /// </list>
    /// The outcome is the first Valid answer; else the first Partial one; else NotFound only when EVERY server affirmatively
    /// said so; else Unavailable. Each caller reads one server its own way (its limiter turn, its gate) and maps the answer
    /// to a <see cref="ServerState"/>; an exception from <c>readAt</c> (cancellation, a refusal of JE's own such as the read
    /// budget) stops the read at once.
    /// </summary>
    internal static class SeerrFallback
    {
        /// <summary>The outcome of the server states (the table, without values).</summary>
        /// <param name="servers">Each server's state, in order (a Valid one ends the read).</param>
        /// <returns>The outcome.</returns>
        public static FallbackState Decide(IReadOnlyList<ServerState> servers) =>
            servers.Contains(ServerState.Valid) ? FallbackState.Valid
            : servers.Contains(ServerState.Partial) ? FallbackState.Partial
            : servers.Count > 0 && servers.All(s => s == ServerState.NotFound) ? FallbackState.NotFound
            : FallbackState.Unavailable;

        /// <summary>Reads every server in order by the table.</summary>
        /// <typeparam name="T">The answer's value.</typeparam>
        /// <param name="urls">The servers, in order.</param>
        /// <param name="readAt">Reads one server (its index too): its state and value.</param>
        /// <returns>The outcome.</returns>
        public static async Task<FallbackResult<T>> ReadAsync<T>(IReadOnlyList<string> urls, Func<string, int, Task<ServerAnswer<T>>> readAt)
        {
            var states = new List<ServerState>(urls.Count);
            ServerAnswer<T>? partial = null;
            Exception? firstError = null;
            for (var i = 0; i < urls.Count; i++)
            {
                var answer = await readAt(urls[i], i).ConfigureAwait(false);
                states.Add(answer.State);
                switch (answer.State)
                {
                    case ServerState.Valid:
                        return new FallbackResult<T>(FallbackState.Valid, answer.Value, states, firstError);
                    case ServerState.Partial:
                        partial ??= answer;
                        break;
                    case ServerState.Malformed or ServerState.Unavailable:
                        firstError ??= answer.Error;
                        break;
                }
            }

            var state = Decide(states);
            return new FallbackResult<T>(state, state == FallbackState.Partial ? partial!.Value.Value : default, states, firstError);
        }
    }
}
