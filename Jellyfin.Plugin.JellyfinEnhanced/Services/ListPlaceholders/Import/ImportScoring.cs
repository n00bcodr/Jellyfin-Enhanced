using System;
using System.Globalization;
using System.Linq;
using System.Text;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import
{
    /// <summary>
    /// Pure scoring rules of the import resolver (research/seerr-api.md §9, design E1–E2). Scale:
    /// <list type="bullet">
    /// <item>title: normalized exact +100 (+5 when the leading article matches too), prefix +60 ("Birds of Prey" →
    /// "Birds of Prey (and the Fantabulous …)"), substring +30, query contains the candidate +20;</item>
    /// <item>year: Δ0 +50, Δ1 +25, otherwise −40; an undated candidate when a year was given −30;</item>
    /// <item>tie-breakers: up to +10 from TMDB votes and up to +5 from popularity;</item>
    /// <item>explicit ids (TMDB/IMDb/TVDB) score <see cref="ExplicitIdScore"/>.</item>
    /// </list>
    /// Confidence: high = top ≥ 150 and margin ≥ 40; medium = top ≥ 100 and margin ≥ 20; else low. A line without a
    /// year can't be high, a tie between exact title matches is low, and reviewed kinds (TBA, alternatives, missing
    /// season/episode, episode by title) are capped at low by the resolver.
    /// </summary>
    public static class ImportScoring
    {
        /// <summary>Score of a candidate found by an explicit id.</summary>
        public const double ExplicitIdScore = 200;

        /// <summary>High-confidence floor.</summary>
        public const double HighScore = 150;

        /// <summary>High-confidence margin over the runner-up.</summary>
        public const double HighMargin = 40;

        /// <summary>Medium-confidence floor.</summary>
        public const double MediumScore = 100;

        /// <summary>Medium-confidence margin.</summary>
        public const double MediumMargin = 20;

        private static readonly System.Collections.Generic.Dictionary<string, string> NumberWords = new(StringComparer.Ordinal)
        {
            ["one"] = "1", ["two"] = "2", ["three"] = "3", ["four"] = "4", ["five"] = "5", ["six"] = "6",
            ["seven"] = "7", ["eight"] = "8", ["nine"] = "9", ["ten"] = "10", ["eleven"] = "11", ["twelve"] = "12",
        };

        /// <summary>Confidence names.</summary>
        public static class Levels
        {
            /// <summary>Accept automatically.</summary>
            public const string High = "high";

            /// <summary>Probably right; one click to accept.</summary>
            public const string Medium = "medium";

            /// <summary>Review.</summary>
            public const string Low = "low";

            /// <summary>Nothing found.</summary>
            public const string None = "none";
        }

        /// <summary>
        /// Lowercase ASCII title without punctuation, "&amp;" as "and", single spaces and (optionally) without a leading
        /// article.
        /// </summary>
        /// <param name="title">Title.</param>
        /// <param name="dropArticle">Drop a leading "the", "a" or "an".</param>
        /// <returns>Normalized title.</returns>
        public static string Normalize(string? title, bool dropArticle = true)
        {
            var decomposed = (title ?? string.Empty).Replace("&", " and ", StringComparison.Ordinal).Normalize(NormalizationForm.FormKD);
            var builder = new StringBuilder(decomposed.Length);
            var space = true;
            foreach (var c in decomposed)
            {
                if (CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark)
                {
                    continue;
                }

                if (char.IsLetterOrDigit(c))
                {
                    builder.Append(char.ToLowerInvariant(c));
                    space = false;
                }
                else if (c is '\'' or '’')
                {
                    // "Snyder's" == "Snyders": apostrophes join, they don't split.
                }
                else if (!space)
                {
                    builder.Append(' ');
                    space = true;
                }
            }

            var text = builder.ToString().Trim();
            if (text.Length > 0)
            {
                // "Part One" == "Part 1".
                text = string.Join(' ', text.Split(' ').Select(w => NumberWords.TryGetValue(w, out var digit) ? digit : w));
            }

            if (dropArticle)
            {
                foreach (var article in new[] { "the ", "a ", "an " })
                {
                    if (text.StartsWith(article, StringComparison.Ordinal) && text.Length > article.Length)
                    {
                        return text[article.Length..];
                    }
                }
            }

            return text;
        }

        /// <summary>Title similarity of a candidate (its title or original title, whichever scores more).</summary>
        /// <param name="candidate">Candidate title.</param>
        /// <param name="original">Candidate original title.</param>
        /// <param name="query">Entry title.</param>
        /// <returns>Score and whether it was an exact (normalized) match.</returns>
        public static (double Score, bool Exact) TitleScore(string candidate, string? original, string query)
        {
            var best = One(candidate, query);
            if (!string.IsNullOrWhiteSpace(original))
            {
                var other = One(original, query);
                if (other.Score > best.Score)
                {
                    best = other;
                }
            }

            return best;

            static (double Score, bool Exact) One(string name, string wanted)
            {
                var n = Normalize(name);
                var q = Normalize(wanted);
                if (n.Length == 0 || q.Length == 0)
                {
                    return (0, false);
                }

                if (n == q)
                {
                    // Article-aware exact beats article-insensitive ("Suicide Squad" vs "The Suicide Squad").
                    return (Normalize(name, false) == Normalize(wanted, false) ? 105 : 100, true);
                }

                if (n.StartsWith(q + " ", StringComparison.Ordinal))
                {
                    return (60, false);
                }

                if ((" " + n + " ").Contains(" " + q + " ", StringComparison.Ordinal))
                {
                    return (30, false);
                }

                if (n.Contains(' ', StringComparison.Ordinal) && (" " + q + " ").Contains(" " + n + " ", StringComparison.Ordinal))
                {
                    return (20, false);
                }

                return (0, false);
            }
        }

        /// <summary>Year agreement.</summary>
        /// <param name="candidateYear">Candidate year (null = undated).</param>
        /// <param name="wantedYear">Entry year (null = no evidence, scores 0).</param>
        /// <returns>Score.</returns>
        public static double YearScore(int? candidateYear, int? wantedYear)
        {
            if (!wantedYear.HasValue)
            {
                return 0;
            }

            if (!candidateYear.HasValue)
            {
                return -30;
            }

            var delta = Math.Abs(candidateYear.Value - wantedYear.Value);
            return delta == 0 ? 50 : delta == 1 ? 25 : -40;
        }

        /// <summary>Tie-breaker from TMDB votes (≤ 10) and popularity (≤ 5).</summary>
        /// <param name="voteCount">Votes.</param>
        /// <param name="popularity">Popularity.</param>
        /// <returns>Score.</returns>
        public static double Tiebreak(int voteCount, double popularity) =>
            (Math.Min(Math.Max(voteCount, 0), 5000) / 500.0) + (Math.Min(Math.Max(popularity, 0), 100) / 20.0);

        /// <summary>Confidence of the best candidate.</summary>
        /// <param name="top">Best score (null = no candidate).</param>
        /// <param name="second">Runner-up score.</param>
        /// <param name="exactTie">Both are exact title matches within 10 points.</param>
        /// <param name="hasYear">The entry gave a year (or an explicit id).</param>
        /// <returns>Level.</returns>
        public static string Confidence(double? top, double? second, bool exactTie, bool hasYear)
        {
            if (!top.HasValue)
            {
                return Levels.None;
            }

            if (exactTie)
            {
                return Levels.Low;
            }

            var margin = top.Value - (second ?? 0);
            var level = top.Value >= HighScore && margin >= HighMargin ? Levels.High
                : top.Value >= MediumScore && margin >= MediumMargin ? Levels.Medium
                : Levels.Low;
            return level == Levels.High && !hasYear ? Levels.Medium : level;
        }

        /// <summary>
        /// True when the best candidate is far better known than the runner-up (≥ 20× its TMDB votes and ≥ 500 votes):
        /// a same-name obscure title (a 1967 short, a 2023 documentary series) then only lowers confidence to medium.
        /// </summary>
        /// <param name="topVotes">Best candidate's votes.</param>
        /// <param name="secondVotes">Runner-up's votes (null = none).</param>
        /// <returns>Whether the best candidate dominates.</returns>
        public static bool Dominates(int topVotes, int? secondVotes) =>
            topVotes >= 500 && (!secondVotes.HasValue || (long)Math.Max(secondVotes.Value, 0) * 20 <= topVotes);

        /// <summary>Lowers a level to at most <paramref name="cap"/>.</summary>
        /// <param name="level">Level.</param>
        /// <param name="cap">Cap.</param>
        /// <returns>The lower of the two.</returns>
        public static string Cap(string level, string cap) => Rank(level) <= Rank(cap) ? level : cap;

        private static int Rank(string level) => level switch
        {
            Levels.High => 3,
            Levels.Medium => 2,
            Levels.Low => 1,
            _ => 0,
        };
    }
}
