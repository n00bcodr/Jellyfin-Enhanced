using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Home
{
    /// <summary>A followed title's next date from TMDB: a movie's digital (else physical) release, a series' next episode.</summary>
    /// <param name="Date">The day (midnight UTC).</param>
    /// <param name="Season">Season of the next episode (series).</param>
    /// <param name="Episode">Number of the next episode (series).</param>
    public sealed record FollowDate(DateTime Date, int? Season, int? Episode)
    {
        /// <inheritdoc />
        public override string ToString() => Date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + "/" + Season + "/" + Episode;
    }

    /// <summary>
    /// Dates for followed titles no Sonarr/Radarr holds (so no arr gives one), read from TMDB through the shared
    /// <see cref="TmdbResponseCache"/> with the server's key: bounded concurrency and one short budget per answer, so a
    /// slow TMDB costs the home rows a date, never the page. Theatrical dates are left out (not watchable at home).
    /// </summary>
    public static class FollowDates
    {
        private const int Concurrency = 4;
        private static readonly TimeSpan Budget = TimeSpan.FromSeconds(3);

        /// <summary>Reads the dates (keys whose lookup fails or has no date are left out).</summary>
        /// <param name="tmdb">The shared TMDB cache.</param>
        /// <param name="region">The server's metadata country.</param>
        /// <param name="titles">(title, TMDB id) pairs.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>Dates by title key.</returns>
        public static async Task<Dictionary<string, FollowDate>> ReadAsync(TmdbResponseCache tmdb, string region, IReadOnlyList<(TitleKey Key, int Tmdb)> titles, CancellationToken ct)
        {
            var result = new Dictionary<string, FollowDate>(StringComparer.Ordinal);
            var apiKey = JellyfinEnhanced.Instance?.Configuration.GetTmdbApiKey();
            if (string.IsNullOrEmpty(apiKey) || titles.Count == 0) return result;
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(Budget);
            using var gate = new SemaphoreSlim(Concurrency);
            var answers = await Task.WhenAll(titles.Select(async t =>
            {
                try
                {
                    await gate.WaitAsync(budget.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return (t.Key, (FollowDate?)null);
                }
                try
                {
                    var media = t.Key.IsMovie ? "movie" : "tv";
                    var path = media + "/" + t.Tmdb.ToString(CultureInfo.InvariantCulture);
                    var details = await tmdb.GetAsync(path, string.Empty, apiKey, budget.Token, bundle: true).ConfigureAwait(false);
                    if (!details.IsSuccess) return (t.Key, null);
                    if (!t.Key.IsMovie) return (t.Key, NextEpisode(details.Content));
                    var releases = await tmdb.GetAsync(path + "/release_dates", string.Empty, apiKey, budget.Token, bundle: true).ConfigureAwait(false);
                    return (t.Key, releases.IsSuccess ? HomeRelease(releases.Content, region, DateTime.UtcNow) : null);
                }
                catch (Exception) when (!ct.IsCancellationRequested)
                {
                    return (t.Key, (FollowDate?)null);
                }
                finally
                {
                    gate.Release();
                }
            })).ConfigureAwait(false);
            ct.ThrowIfCancellationRequested();
            foreach (var (key, date) in answers)
            {
                if (date != null) result[key.Title.ToString()] = date;
            }
            return result;
        }

        /// <summary>A series' next episode from TMDB's details (<c>next_episode_to_air</c>), or null.</summary>
        /// <param name="details">TMDB tv details JSON.</param>
        /// <returns>The date, or null.</returns>
        internal static FollowDate? NextEpisode(string details)
        {
            try
            {
                using var doc = JsonDocument.Parse(details);
                if (!doc.RootElement.TryGetProperty("next_episode_to_air", out var next) || next.ValueKind != JsonValueKind.Object) return null;
                if (Day(next, "air_date") is not DateTime day) return null;
                return new FollowDate(day, Int(next, "season_number"), Int(next, "episode_number"));
            }
            catch (JsonException)
            {
                return null;
            }
        }

        /// <summary>
        /// A movie's next home release in the region (else the US): the earliest digital (type 4), else physical (type 5)
        /// release still ahead, or null.
        /// </summary>
        /// <param name="releases">TMDB release_dates JSON.</param>
        /// <param name="region">Region code.</param>
        /// <param name="now">Now (UTC).</param>
        /// <returns>The date, or null.</returns>
        internal static FollowDate? HomeRelease(string releases, string region, DateTime now)
        {
            try
            {
                using var doc = JsonDocument.Parse(releases);
                if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array) return null;
                foreach (var code in new[] { region, "US" }.Distinct(StringComparer.OrdinalIgnoreCase))
                {
                    var country = results.EnumerateArray().FirstOrDefault(r => r.TryGetProperty("iso_3166_1", out var c) && string.Equals(c.GetString(), code, StringComparison.OrdinalIgnoreCase));
                    if (country.ValueKind != JsonValueKind.Object || !country.TryGetProperty("release_dates", out var dates) || dates.ValueKind != JsonValueKind.Array) continue;
                    foreach (var type in new[] { 4, 5 })
                    {
                        var ahead = dates.EnumerateArray().Where(d => Int(d, "type") == type).Select(d => Day(d, "release_date"))
                            .Where(d => d is DateTime at && StatusComposer.DayStillAhead(at, now)).Select(d => d!.Value).OrderBy(d => d).ToList();
                        if (ahead.Count > 0) return new FollowDate(ahead[0], null, null);
                    }
                }
                return null;
            }
            catch (JsonException)
            {
                return null;
            }
        }

        private static int? Int(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : null;

        // TMDB dates: "2026-11-14" or "2026-11-14T00:00:00.000Z"; the calendar day, as midnight UTC.
        private static DateTime? Day(JsonElement e, string name)
        {
            if (!e.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.String) return null;
            var text = v.GetString();
            if (text == null || text.Length < 10) return null;
            return DateTime.TryParseExact(text.AsSpan(0, 10), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var day)
                ? DateTime.SpecifyKind(day, DateTimeKind.Utc)
                : null;
        }
    }
}
