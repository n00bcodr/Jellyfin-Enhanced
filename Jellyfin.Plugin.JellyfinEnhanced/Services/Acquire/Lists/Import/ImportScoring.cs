using System;
using System.Globalization;
using System.Linq;
using System.Text;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import
{
    /// <summary>
    /// Pure scoring rules of the import resolver (research/seerr-api.md §9, design E1–E2). Scale:
    /// <list type="bullet">
    /// <item>title: normalized exact +100 (+5 when the leading article matches too); spacing, hashtags and roman
    /// numerals don't count ("Star Crossed" = "Starcrossed", "#TheLateBatsby", "Special 2" = "Special II"); +60 for a
    /// title that is the other one with something added: a prefix ("Birds of Prey" → "Birds of Prey (and the Fantabulous
    /// …)"), a leading franchise segment ("DC Showcase - …", "Watchmen: …"), a subtitle only the line has ("Blackhawk:
    /// Fearless Champion of Freedom" → "Blackhawk") or one extra word in a title of five or more words ("LEGO DC
    /// [Comics] Super Heroes: …"); substring +30, query contains the candidate +20;</item>
    /// <item>year: Δ0 +50, Δ1 +25, otherwise −40; an undated candidate when a year was given −30 (0 when the line says
    /// the title isn't out yet: an announced title has no date on TMDB either);</item>
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

        /// <summary>Title score of a title that is the other one with something added (see the class remarks).</summary>
        public const double PartialTitleScore = 60;

        private static readonly System.Collections.Generic.Dictionary<string, string> NumberWords = new(StringComparer.Ordinal)
        {
            ["one"] = "1", ["two"] = "2", ["three"] = "3", ["four"] = "4", ["five"] = "5", ["six"] = "6",
            ["seven"] = "7", ["eight"] = "8", ["nine"] = "9", ["ten"] = "10", ["eleven"] = "11", ["twelve"] = "12",

            // Roman numerals as whole words ("Special II", "Part IV", "Chapter I"): both sides fold the same way.
            ["i"] = "1", ["ii"] = "2", ["iii"] = "3", ["iv"] = "4", ["v"] = "5", ["vi"] = "6", ["vii"] = "7", ["viii"] = "8",
            ["ix"] = "9", ["x"] = "10", ["xi"] = "11", ["xii"] = "12",
        };

        // Where a title splits into segments: "Franchise: Title", "Series - Title" (not the hyphen inside "Spider-Man").
        private static readonly System.Text.RegularExpressions.Regex SegmentSeparator = new(
            @"\s*:\s*|\s+[-–—]+\s+|\s*[–—]\s*",
            System.Text.RegularExpressions.RegexOptions.Compiled | System.Text.RegularExpressions.RegexOptions.CultureInvariant);

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
        /// Lowercase ASCII title without punctuation, "&amp;" as "and", number words and roman numerals as digits, single
        /// spaces and (optionally) without a leading article.
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

                if (Compact(n) == Compact(q) || Compact(Normalize(name, false)) == Compact(Normalize(wanted, false)))
                {
                    // Only the spacing differs: "Star Crossed"/"Starcrossed", "#TheLateBatsby"/"The Late Batsby".
                    return (100, true);
                }

                if (StartsWithWords(n, q) || IsPartOf(name, wanted) || OneWordApart(n, q))
                {
                    return (PartialTitleScore, false);
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

        /// <summary>
        /// The search texts worth trying when a title found nothing that resembles it, best first: the title with
        /// hashtags/CamelCase split ("#TheLateBatsby" → "The Late Batsby"), its main title when it has a subtitle
        /// ("Blackhawk: Fearless Champion of Freedom" → "Blackhawk"), the title without its last word (TMDB matches the
        /// last word as a prefix, so "Justice League: Star" finds "Starcrossed") and without its longest word (a word the
        /// title spells as one: "Superpower" for "Super Power").
        /// </summary>
        /// <param name="title">Line title.</param>
        /// <returns>Distinct queries other than the title itself.</returns>
        public static System.Collections.Generic.IReadOnlyList<string> FallbackQueries(string title)
        {
            var result = new System.Collections.Generic.List<string>();
            void Add(string? query)
            {
                query = string.Join(' ', (query ?? string.Empty).Split(' ', StringSplitOptions.RemoveEmptyEntries)).Trim();
                if (Normalize(query).Length >= 2 && !string.Equals(query, title.Trim(), StringComparison.OrdinalIgnoreCase)
                    && !result.Contains(query, StringComparer.OrdinalIgnoreCase))
                {
                    result.Add(query);
                }
            }

            Add(System.Text.RegularExpressions.Regex.Replace(title.Replace("#", " ", StringComparison.Ordinal), "(?<=\\p{Ll})(?=\\p{Lu})", " "));
            var segments = Segments(title);
            if (segments.Count > 1 && LooksLikeSubtitle(string.Join(' ', segments.Skip(1))))
            {
                Add(segments[0]);
            }

            var words = title.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (words.Length >= 3)
            {
                Add(string.Join(' ', words.Take(words.Length - 1)));
                var longest = words.Select((w, i) => (Length: Normalize(w, false).Length, Index: i)).OrderByDescending(w => w.Length).ThenBy(w => w.Index).First();
                Add(string.Join(' ', words.Where((_, i) => i != longest.Index)));
            }

            return result;
        }

        // The title without its spaces (normalized).
        private static string Compact(string normalized) => normalized.Replace(" ", string.Empty, StringComparison.Ordinal);

        // `title` begins with all of `prefix`'s words (spacing aside): "birds of prey and the …" / "birds of prey".
        private static bool StartsWithWords(string title, string prefix)
        {
            var target = Compact(prefix);
            var built = new StringBuilder();
            var words = title.Split(' ');
            for (var i = 0; i < words.Length - 1; i++)
            {
                built.Append(words[i]);
                if (built.Length >= target.Length)
                {
                    return built.ToString() == target;
                }
            }

            return false;
        }

        // One title is the other with a leading segment ("DC Showcase - Batman: Death in the Family", "Watchmen: Under
        // the Hood"; the rest has ≥ 2 words) or with a subtitle ("Blackhawk: Fearless Champion of Freedom" → "Blackhawk").
        private static bool IsPartOf(string name, string wanted)
        {
            return Tails(name).Contains(Normalize(wanted)) || Tails(wanted).Contains(Normalize(name)) || MainTitle(wanted) == Normalize(name);

            static System.Collections.Generic.List<string> Tails(string title)
            {
                var segments = Segments(title);
                return Enumerable.Range(1, Math.Max(0, segments.Count - 1))
                    .Select(k => Normalize(string.Join(' ', segments.Skip(k))))
                    .Where(t => t.Contains(' ', StringComparison.Ordinal))
                    .ToList();
            }

            static string? MainTitle(string title)
            {
                var segments = Segments(title);
                return segments.Count > 1 && LooksLikeSubtitle(string.Join(' ', segments.Skip(1))) ? Normalize(segments[0]) : null;
            }
        }

        // A subtitle is part of the title: its longer words are capitalised and it has no "/" lists ("Fearless Champion
        // of Freedom", not "Fleischer / Famous Studios cartoons").
        private static bool LooksLikeSubtitle(string text) =>
            !text.Contains('/', StringComparison.Ordinal)
            && text.Split(' ', StringSplitOptions.RemoveEmptyEntries).Where(w => w.Count(char.IsLetter) >= 4).All(w => !char.IsLetter(w.First(char.IsLetterOrDigit)) || char.IsUpper(w.First(char.IsLetterOrDigit)) || char.IsDigit(w.First(char.IsLetterOrDigit)));

        // The longer title is the shorter one (≥ 4 words, so one word is a small part of it) with one extra word:
        // "lego dc comics super heroes the flash". Not "new batman superman adventures" vs "new batman adventures".
        private static bool OneWordApart(string a, string b)
        {
            var x = a.Split(' ');
            var y = b.Split(' ');
            var (longer, shorter) = x.Length > y.Length ? (x, y) : (y, x);
            if (longer.Length != shorter.Length + 1 || shorter.Length < 4)
            {
                return false;
            }

            for (var skip = 0; skip < longer.Length; skip++)
            {
                if (longer.Where((_, i) => i != skip).SequenceEqual(shorter, StringComparer.Ordinal))
                {
                    return true;
                }
            }

            return false;
        }

        private static System.Collections.Generic.List<string> Segments(string title) =>
            SegmentSeparator.Split(title ?? string.Empty).Where(p => p.Trim().Length > 0).ToList();

        /// <summary>Year agreement.</summary>
        /// <param name="candidateYear">Candidate year (null = undated).</param>
        /// <param name="wantedYear">Entry year (null = no evidence, scores 0).</param>
        /// <param name="unreleased">The line says the title isn't out yet: an undated candidate is no evidence either way.</param>
        /// <returns>Score.</returns>
        public static double YearScore(int? candidateYear, int? wantedYear, bool unreleased = false)
        {
            if (!wantedYear.HasValue)
            {
                return 0;
            }

            if (!candidateYear.HasValue)
            {
                return unreleased ? 0 : -30;
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
