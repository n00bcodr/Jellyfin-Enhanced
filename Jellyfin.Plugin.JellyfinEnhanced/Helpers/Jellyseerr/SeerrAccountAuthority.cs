using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr
{
    /// <summary>
    /// The one owner of "which Seerr account is this person, as last read?": per person and per Seerr (the addresses and
    /// API key the configuration points at), a generation that moves on every fresh read that changes or loses the
    /// person's account link — also when nothing was known or cached yet (a first read moves it), so work started before
    /// such a read can't publish what it found. A read that couldn't complete (Seerr didn't answer) observes nothing: an
    /// unknown is never a missing link.
    /// <para>
    /// Every cache, dedupe and send that depends on the person's Seerr account (the proxy's account lookups and its
    /// per-person answers, the request backend's mapping and preparations, the legacy automatic requests) takes a
    /// <see cref="Ticket"/> BEFORE it reads anything, keeps it with what it stores (or in its key), and publishes, serves
    /// or sends only while <see cref="IsCurrent"/>: a ticket is current while its Seerr is still the one configured, no
    /// configuration change ended every ticket (<see cref="Reset"/>) and the person's generation hasn't moved. A read
    /// records what it found through <see cref="Admit"/> with the ticket it began under: one that began before a newer
    /// observation is refused (it can't reinstall an older account), one that changes the link moves the generation and
    /// hands back the ticket its own facts live under.
    /// </para>
    /// </summary>
    internal static class SeerrAccountAuthority
    {
        // A bound on the people × Seerr pairs remembered; past it every ticket ends (safe: work reads again).
        private const int MaxRecords = 100_000;

        private static readonly object Gate = new();
        private static readonly Dictionary<(string Source, string Person), Record> Records = new();
        private static long _epoch;
        private static (string Input, string Id)? _sourceCache;

        /// <summary>What an answer for a person was worked out under. Equal tickets: the same authority.</summary>
        /// <param name="Source">The Seerr (an opaque digest of its addresses and key; empty: not configured).</param>
        /// <param name="Person">The Jellyfin user (N form, lower case).</param>
        /// <param name="Epoch">The configuration epoch (moves on every Seerr settings change).</param>
        /// <param name="Generation">The person's account-link generation at that Seerr.</param>
        internal readonly record struct Ticket(string Source, string Person, long Epoch, long Generation)
        {
            /// <summary>A key part naming this authority (no ':'; part of every per-person cache key).</summary>
            public string Key => Source + "|" + Epoch.ToString(System.Globalization.CultureInfo.InvariantCulture) + "|"
                + Generation.ToString(System.Globalization.CultureInfo.InvariantCulture) + "|" + Person;
        }

        private sealed class Record
        {
            public long Generation;
            public bool Known;
            public int? Account;
        }

        /// <summary>The person's id as the authority keys it (N form, lower case).</summary>
        /// <param name="jellyfinUserId">A Jellyfin user id in any form.</param>
        /// <returns>The key.</returns>
        internal static string PersonOf(string jellyfinUserId)
            => (jellyfinUserId ?? string.Empty).Replace("-", string.Empty, StringComparison.Ordinal).ToLowerInvariant();

        /// <summary>The person's id as the authority keys it.</summary>
        /// <param name="jellyfinUserId">A Jellyfin user id.</param>
        /// <returns>The key.</returns>
        internal static string PersonOf(Guid jellyfinUserId) => jellyfinUserId.ToString("N");

        /// <summary>
        /// The Seerr a configuration points at: a keyed digest of its addresses (normalised, sorted, without repeats) and
        /// API key, never the key; empty while Seerr isn't configured. Another address or key is another Seerr.
        /// </summary>
        /// <param name="config">The configuration.</param>
        /// <returns>The digest.</returns>
        internal static string SourceOf(PluginConfiguration? config)
        {
            if (config == null || string.IsNullOrWhiteSpace(config.JellyseerrUrls)) return string.Empty;
            var key = config.GetJellyseerrApiKey() ?? string.Empty;
            if (key.Length == 0) return string.Empty;
            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(u => u.Trim().TrimEnd('/'))
                .Where(u => u.Length > 0)
                .Select(u => Uri.TryCreate(u, UriKind.Absolute, out var uri) ? uri.GetLeftPart(UriPartial.Path).TrimEnd('/') : u)
                .Distinct(StringComparer.Ordinal)
                .OrderBy(u => u, StringComparer.Ordinal);
            var joined = string.Join("\n", urls);
            var input = joined + "\n" + key;
            var cached = _sourceCache;
            if (cached is { } held && held.Input == input) return held.Id;
            using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(key));
            var id = Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes(joined)), 0, 8).ToLowerInvariant();
            _sourceCache = (input, id);
            return id;
        }

        /// <summary>The person's ticket now: take it BEFORE reading anything the answer depends on.</summary>
        /// <param name="source">The Seerr (<see cref="SourceOf"/>).</param>
        /// <param name="person">The person (<see cref="PersonOf(string)"/>).</param>
        /// <returns>The ticket.</returns>
        internal static Ticket Capture(string source, string person)
        {
            lock (Gate)
            {
                var generation = Records.TryGetValue((source, person), out var record) ? record.Generation : 0;
                return new Ticket(source, person, _epoch, generation);
            }
        }

        /// <summary>The ticket of the person at the Seerr configured now.</summary>
        /// <param name="config">The configuration.</param>
        /// <param name="jellyfinUserId">The person.</param>
        /// <returns>The ticket.</returns>
        internal static Ticket Capture(PluginConfiguration? config, string jellyfinUserId) => Capture(SourceOf(config), PersonOf(jellyfinUserId));

        /// <summary>Whether what was worked out under <paramref name="ticket"/> may still be served, kept or sent.</summary>
        /// <param name="ticket">The ticket taken before the read.</param>
        /// <returns>True while no observation or configuration change ended it.</returns>
        internal static bool IsCurrent(in Ticket ticket)
        {
            lock (Gate)
            {
                var generation = Records.TryGetValue((ticket.Source, ticket.Person), out var record) ? record.Generation : 0;
                return ticket.Epoch == _epoch && ticket.Generation == generation;
            }
        }

        /// <summary>
        /// Whether <paramref name="ticket"/> is current AND still names the Seerr the configuration points at now (a
        /// configuration changed without its own clear).
        /// </summary>
        /// <param name="ticket">The ticket.</param>
        /// <param name="config">The configuration now.</param>
        /// <returns>True when current for that Seerr.</returns>
        internal static bool IsCurrent(in Ticket ticket, PluginConfiguration? config)
            => ticket.Source == SourceOf(config) && IsCurrent(ticket);

        /// <summary>
        /// A read that began under <paramref name="ticket"/> found the person's account (<paramref name="account"/>; null:
        /// Seerr completely listed its accounts and links none to them). Refused when another observation or a
        /// configuration change came after the ticket (an older read can't reinstall an account). Otherwise recorded:
        /// when it changes or loses what was known (or nothing was known), the person's generation moves and every
        /// answer worked out under an older ticket ends. <paramref name="ticket"/> becomes the one this read's own facts
        /// live under.
        /// </summary>
        /// <param name="ticket">The ticket the read began under; updated.</param>
        /// <param name="account">What it found.</param>
        /// <returns>False when superseded (nothing found by it may be kept or used).</returns>
        internal static bool Admit(ref Ticket ticket, int? account)
        {
            lock (Gate)
            {
                var key = (ticket.Source, ticket.Person);
                Records.TryGetValue(key, out var record);
                if (ticket.Epoch != _epoch || ticket.Generation != (record?.Generation ?? 0)) return false;
                if (record == null)
                {
                    if (Records.Count >= MaxRecords) { Records.Clear(); _epoch++; return false; }
                    record = new Record();
                    Records[key] = record;
                }

                if (!record.Known || record.Account != account)
                {
                    record.Generation++;
                    record.Known = true;
                    record.Account = account;
                }

                ticket = ticket with { Generation = record.Generation };
                return true;
            }
        }

        /// <summary>
        /// A read made just now elsewhere found the person's account (null: none linked): recorded as by
        /// <see cref="Admit"/> with a current ticket. For a caller that only reports what it read.
        /// </summary>
        /// <param name="source">The Seerr it read.</param>
        /// <param name="person">The person.</param>
        /// <param name="account">What it found.</param>
        internal static void Observed(string source, string person, int? account)
        {
            var ticket = Capture(source, person);
            while (!Admit(ref ticket, account)) ticket = Capture(source, person);
        }

        /// <summary>The Seerr settings changed (or every Seerr cache was dropped): every ticket ends, nothing is known.</summary>
        internal static void Reset()
        {
            lock (Gate)
            {
                _epoch++;
                Records.Clear();
            }
        }
    }
}
