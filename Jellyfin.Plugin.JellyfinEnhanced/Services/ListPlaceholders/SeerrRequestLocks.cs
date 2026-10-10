using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>
    /// Process-wide, per-title locks around automatic Seerr requests. Seerr's duplicate-request check (find an existing
    /// request, then save) is not atomic, so two automatic requests for the same title that overlap in time (two users,
    /// or list auto-requests and Auto Movie/Season Requests firing on the same playback) can both be accepted. Holding
    /// this lock across "read the title's current Seerr status → POST" (list auto-requests) and around the POST (the
    /// sibling services) serialises them: the later one either sees the earlier request in its status re-check or gets
    /// Seerr's 409. Keyed by media type + TMDB id (not season), so a series placeholder whose season is only known after
    /// the details lookup is covered too. Entries are removed when the last holder/waiter leaves.
    /// </summary>
    public static class SeerrRequestLocks
    {
        private static readonly Dictionary<string, Entry> Entries = new(StringComparer.Ordinal);

        /// <summary>The lock key of a title.</summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <returns>The key.</returns>
        public static string TitleKey(string mediaType, int tmdbId) =>
            string.Create(CultureInfo.InvariantCulture, $"{(mediaType == "tv" ? "tv" : "movie")}|{tmdbId}");

        /// <summary>The lock key of a title given as a string id (sibling services); trimmed, numeric ids normalised.</summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <returns>The key.</returns>
        public static string TitleKey(string mediaType, string tmdbId) =>
            int.TryParse(tmdbId?.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var id)
                ? TitleKey(mediaType, id)
                : (mediaType == "tv" ? "tv|" : "movie|") + (tmdbId?.Trim() ?? string.Empty);

        /// <summary>Waits for the title's lock. Dispose the result to release it.</summary>
        /// <param name="key">Key from <see cref="TitleKey(string, int)"/>.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The held lock.</returns>
        public static async Task<IDisposable> AcquireAsync(string key, CancellationToken cancellationToken)
        {
            Entry entry;
            lock (Entries)
            {
                if (!Entries.TryGetValue(key, out entry!))
                {
                    entry = new Entry();
                    Entries[key] = entry;
                }

                entry.Users++;
            }

            try
            {
                await entry.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                Leave(key, entry);
                throw;
            }

            return new Holder(key, entry);
        }

        private static void Leave(string key, Entry entry)
        {
            lock (Entries)
            {
                if (--entry.Users == 0)
                {
                    Entries.Remove(key);
                    entry.Gate.Dispose();
                }
            }
        }

        private sealed class Entry
        {
            public SemaphoreSlim Gate { get; } = new(1, 1);

            public int Users { get; set; }
        }

        private sealed class Holder : IDisposable
        {
            private readonly string _key;
            private Entry? _entry;

            public Holder(string key, Entry entry)
            {
                _key = key;
                _entry = entry;
            }

            public void Dispose()
            {
                var entry = Interlocked.Exchange(ref _entry, null);
                if (entry != null)
                {
                    entry.Gate.Release();
                    Leave(_key, entry);
                }
            }
        }
    }
}
