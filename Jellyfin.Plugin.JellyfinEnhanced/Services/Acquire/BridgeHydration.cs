using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>What the read-back of one just-imported item says (<see cref="BridgeHydration.Judge"/>).</summary>
    /// <param name="Missing">What still keeps it from showing properly (a raw title, no overview, no poster, no media info, no episode numbers).</param>
    /// <param name="SoftMissing">What would be nice but a provider may legitimately not have (a backdrop, an episode still, an episode title or overview).</param>
    public sealed record HydrationJudgement(IReadOnlyList<string> Missing, IReadOnlyList<string> SoftMissing)
    {
        /// <summary>Nothing is missing.</summary>
        public bool Complete => Missing.Count == 0 && SoftMissing.Count == 0;

        /// <summary>It doesn't show properly yet (the raw folder name, no overview or poster, no media info): it needs its metadata read.</summary>
        public bool Skeletal => Missing.Count > 0;

        /// <summary>Everything it needs is there; only what a provider may not have is missing.</summary>
        public bool OnlySoftMissing => Missing.Count == 0 && SoftMissing.Count > 0;

        /// <summary>The missing facts as one short line (logs, the System tab).</summary>
        public string Describe() => string.Join(", ", Missing.Concat(SoftMissing));
    }

    /// <summary>
    /// The rule a just-imported item's metadata is judged by before JE calls it Ready (Requests &amp; downloads, bridge).
    /// Jellyfin's resolver names a new movie after its folder ("Project Almanac (2015) {tmdb-227719}") and a new series
    /// after its folder, and can take the provider id from that folder name before any provider ran: a provider id alone
    /// proves nothing. A movie or series is usable once it has its providers' title (not the folder name or a provider
    /// tag), an overview and a poster (and a movie its media info); an episode once it is numbered and bound to its season
    /// and series, its file is read, and its series is usable. A backdrop, an episode's own title, overview and still are
    /// filled when the providers have them, never waited for beyond one hydration.
    /// </summary>
    public static class BridgeHydration
    {
        // "{tmdb-227719}", "[tmdbid-45745]", "[imdbid=tt0133093]", "{tvdb-78874}": a provider tag left in a folder or file name.
        private static readonly Regex ProviderTag = new(@"[\[\{]\s*(tmdb|tvdb|imdb)(id)?\s*[-=]", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(200));

        /// <summary>Judges one item's facts (an episode's series facts included).</summary>
        /// <param name="facts">The item's facts.</param>
        /// <returns>What is missing.</returns>
        public static HydrationJudgement Judge(JfItemFacts facts)
        {
            var missing = new List<string>();
            var soft = new List<string>();
            switch (facts.Kind)
            {
                case "movie":
                    if (RawTitle(facts, FolderName(facts.Path)) || RawTitle(facts, StemOf(facts.Path))) missing.Add("title");
                    if (!facts.HasOverview) missing.Add("overview");
                    if (!facts.HasPrimary) missing.Add("poster");
                    if (!facts.Probed) missing.Add("media info");
                    if (!facts.HasBackdrop) soft.Add("backdrop");
                    break;
                case "series":
                    Series(facts, string.Empty, missing, soft);
                    break;
                case "episode":
                    if (facts.Season == null || facts.Episode == null) missing.Add("episode numbers");
                    if (facts.SeriesId.Equals(Guid.Empty) || facts.SeasonId.Equals(Guid.Empty)) missing.Add("season");
                    if (!facts.Probed) missing.Add("media info");
                    if (facts.Series == null) missing.Add("series");
                    else Series(facts.Series, "series ", missing, soft);
                    if (RawTitle(facts, StemOf(facts.Path))) soft.Add("episode title");
                    if (!facts.HasOverview) soft.Add("episode overview");
                    if (!facts.HasPrimary) soft.Add("episode image");
                    break;
                default:
                    // Anything else a file can become (a folder, an extra) has nothing JE waits for.
                    break;
            }
            return new HydrationJudgement(missing, soft);
        }

        private static void Series(JfItemFacts series, string prefix, List<string> missing, List<string> soft)
        {
            if (RawTitle(series, LastSegment(series.Path))) missing.Add(prefix + "title");
            if (!series.HasOverview) missing.Add(prefix + "overview");
            if (!series.HasPrimary) missing.Add(prefix + "poster");
            if (!series.HasBackdrop) soft.Add(prefix + "backdrop");
        }

        /// <summary>
        /// True while the item shows a raw name: none, one with a provider tag, or the folder or file name it was resolved
        /// from while no provider has given it an overview (a folder named exactly as the title is fine once one has).
        /// A title an administrator locked is never "raw".
        /// </summary>
        internal static bool RawTitle(JfItemFacts facts, string? resolvedFrom)
        {
            if (facts.NameLocked) return false;
            var name = facts.Name?.Trim();
            if (string.IsNullOrEmpty(name)) return true;
            if (ProviderTag.IsMatch(name)) return true;
            return !facts.HasOverview && !string.IsNullOrEmpty(resolvedFrom) && string.Equals(name, resolvedFrom.Trim(), StringComparison.OrdinalIgnoreCase);
        }

        private static string? LastSegment(string? path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            var p = BridgePaths.Norm(path);
            return p[(p.LastIndexOf('/') + 1)..];
        }

        // A movie's name comes from its folder (a movie folder) or its file (a loose file).
        private static string? FolderName(string? file)
        {
            if (string.IsNullOrEmpty(file)) return null;
            var folder = BridgePaths.Parent(file);
            return folder == null ? null : LastSegment(folder);
        }

        private static string? StemOf(string? file) => string.IsNullOrEmpty(file) ? null : Path.GetFileNameWithoutExtension(LastSegment(file));
    }
}
