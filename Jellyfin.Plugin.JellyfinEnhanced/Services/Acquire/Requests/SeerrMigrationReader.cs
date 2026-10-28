using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>Whether people can still ask in Seerr: disabled, enabled, or unknown (the settings could not be read).</summary>
    /// <param name="State">disabled, enabled or unknown.</param>
    /// <param name="RequestingUsers">Non-admin Seerr users who still hold a request permission.</param>
    /// <param name="Admins">Seerr administrators (they can always ask in Seerr).</param>
    /// <param name="DefaultAllowsRequests">New Seerr users would get a request permission.</param>
    public sealed record SeerrRequestingState(string State, int RequestingUsers, int Admins, bool DefaultAllowsRequests);

    /// <summary>
    /// A complete-or-nothing read of every request Seerr holds, for the authority transfer. Separate from
    /// the capped background read model: it pages through the whole list from one address, and the read is
    /// complete only when Seerr's total stays the same on every page and on a final re-check, the ids come
    /// newest first with no repeats, as many arrive as Seerr reported, and every request Seerr changed since
    /// the read began is still as it was read. A change Seerr makes after that final check isn't seen; JE's own
    /// Seerr request writes are held off while a move runs (<see cref="SeerrRequestWriteFence"/>).
    /// </summary>
    /// <param name="Complete">Every request was read.</param>
    /// <param name="IncompleteReason">Why not (not_configured, unreachable, page_failed, total_changed, order_changed, row_changed, short_page, too_many).</param>
    /// <param name="Rows">Every request, newest first (empty when incomplete).</param>
    /// <param name="Unreadable">Ids of requests that could not be understood (counted, never imported).</param>
    /// <param name="Total">Seerr's reported total.</param>
    /// <param name="Digest">Digest of the complete set (empty when incomplete); any change in Seerr changes it.</param>
    /// <param name="AddressFingerprint">Hash of the normalised address set, without the API key.</param>
    /// <param name="Requesting">Whether people can still ask in Seerr.</param>
    public sealed record SeerrMigrationRead(bool Complete, string? IncompleteReason, IReadOnlyList<SeerrRequestRecord> Rows, IReadOnlyList<int> Unreadable,
        int Total, string Digest, string AddressFingerprint, SeerrRequestingState Requesting);

}
