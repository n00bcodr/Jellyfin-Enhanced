using System;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>What a queue row means, by one precedence table (status composer, Needs attention, first-seen clocks).</summary>
    public enum ArrQueueClass
    {
        /// <summary>A state the table doesn't know: never progress, never importing or ready.</summary>
        Unknown = 0,

        /// <summary>Downloading (the client said so).</summary>
        Downloading,

        /// <summary>
        /// "Downloading" with data still missing while the client says no time is left: no progress.
        /// A problem (Needs attention's "download stalled"); the family still reads it as downloading.
        /// </summary>
        Stalled,

        /// <summary>Waiting in line in the download client (queued, paused).</summary>
        Queued,

        /// <summary>Held by a delay profile (or Sonarr's fallback).</summary>
        Delayed,

        /// <summary>Downloaded; the arr is importing it.</summary>
        Importing,

        /// <summary>The download client can't be reached.</summary>
        ClientUnavailable,

        /// <summary>The arr warns about a download that is still downloading.</summary>
        Warned,

        /// <summary>Downloaded, and the arr warns why it can't import it (or its import failed).</summary>
        ImportWarned,

        /// <summary>The arr says the download needs a manual import.</summary>
        ImportBlocked,

        /// <summary>The download failed.</summary>
        Failed,
    }

    /// <summary>
    /// The one precedence table for queue rows: failed, import blocked, client unavailable, warnings
    /// (a finished download the arr can't import is not "downloading"), delay, importing, queued,
    /// finished, downloading. Anything else is <see cref="ArrQueueClass.Unknown"/>. Case-insensitive.
    /// </summary>
    public static class ArrQueueStates
    {
        /// <summary>The class of a queue row.</summary>
        public static ArrQueueClass Classify(ArrQueueEntry row)
        {
            var cls = Classify(row.Status, row.TrackedDownloadState, row.TrackedDownloadStatus);
            return cls == ArrQueueClass.Downloading && IsStalled(row) ? ArrQueueClass.Stalled : cls;
        }

        /// <summary>The client says no time is left while data is still missing (only meaningful for a downloading row).</summary>
        public static bool IsStalled(ArrQueueEntry row)
            => row.SizeLeft is > 0 && (row.TimeLeft ?? string.Empty).Trim() is "00:00:00" or "0:00:00";

        /// <summary>The class of a download's client status, the arr's pipeline state and its health (ok, warning, error).</summary>
        public static ArrQueueClass Classify(string? status, string? state, string? health)
        {
            var s = (status ?? string.Empty).Trim().ToLowerInvariant();
            var t = (state ?? string.Empty).Trim().ToLowerInvariant();
            var h = (health ?? string.Empty).Trim().ToLowerInvariant();
            if (t is "failed" or "failedpending" || s == "failed") return ArrQueueClass.Failed;
            if (t == "importblocked") return ArrQueueClass.ImportBlocked;
            if (s == "downloadclientunavailable") return ArrQueueClass.ClientUnavailable;
            var finished = s == "completed" || t is "importpending" or "importing" or "importfailed" or "imported";
            if (h is "warning" or "error" || s == "warning") return finished ? ArrQueueClass.ImportWarned : ArrQueueClass.Warned;
            if (t == "importfailed") return ArrQueueClass.ImportWarned;
            if (s is "delay" or "fallback") return ArrQueueClass.Delayed;
            if (t is "importpending" or "importing") return ArrQueueClass.Importing;
            if (s is "queued" or "paused") return ArrQueueClass.Queued;
            if (t == "ignored") return ArrQueueClass.Unknown;
            if (finished) return ArrQueueClass.Importing;
            if (s == "downloading") return ArrQueueClass.Downloading;
            return ArrQueueClass.Unknown;
        }

        /// <summary>True for the classes someone should hear about.</summary>
        public static bool IsProblem(ArrQueueClass c)
            => c is ArrQueueClass.Failed or ArrQueueClass.ImportBlocked or ArrQueueClass.ImportWarned or ArrQueueClass.Warned or ArrQueueClass.ClientUnavailable or ArrQueueClass.Stalled;

        /// <summary>Which of several rows of one title speaks for it: problems first, then the furthest along.</summary>
        public static int Rank(ArrQueueClass c) => c switch
        {
            ArrQueueClass.ImportBlocked or ArrQueueClass.ImportWarned => 9,
            ArrQueueClass.Failed => 8,
            ArrQueueClass.Warned => 7,
            ArrQueueClass.ClientUnavailable => 6,
            ArrQueueClass.Importing => 5,
            ArrQueueClass.Downloading or ArrQueueClass.Stalled => 4,
            ArrQueueClass.Queued => 3,
            ArrQueueClass.Delayed => 2,
            _ => 1,
        };
    }

    /// <summary>
    /// When Jellyfin Enhanced first saw a queue row in its current class (<paramref name="ReasonSince"/>)
    /// and in any problem class (<paramref name="AttentionSince"/>, null while it has none). "First seen
    /// by JE": after a restart, or without live events, it may be late, never early.
    /// </summary>
    /// <param name="Class">The class last seen.</param>
    /// <param name="ReasonSince">Since when (UTC) the row has been in that class.</param>
    /// <param name="AttentionSince">Since when (UTC) the row has needed attention, or null.</param>
    public sealed record ArrQueueSeen(ArrQueueClass Class, DateTime ReasonSince, DateTime? AttentionSince);
}
