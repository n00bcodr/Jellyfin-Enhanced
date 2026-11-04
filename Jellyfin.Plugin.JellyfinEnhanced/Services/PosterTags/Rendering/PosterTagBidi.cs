using System.Collections.Generic;
using System.Globalization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering
{
    /// <summary>
    /// The Unicode bidirectional algorithm (UAX #9) for one line of tag text, without explicit embeddings or
    /// isolates: the paragraph direction comes from the first strong letter (as <c>dir="auto"</c>), numbers stay left
    /// to right inside right-to-left text, bracket pairs resolve together, neutrals take the direction around them,
    /// and the level runs come back in visual order (HarfBuzz mirrors brackets in right-to-left runs). Text without
    /// right-to-left letters or Arabic-Indic digits is one left-to-right run.
    /// </summary>
    internal static class PosterTagBidi
    {
        private enum Kind : byte { L, R, AL, EN, AN, ES, ET, CS, NSM, ON }

        /// <summary>Level runs of <paramref name="text"/> in visual order: start index, length, right to left.</summary>
        internal static IReadOnlyList<(int Start, int Length, bool Rtl)> VisualRuns(string text)
        {
            if (string.IsNullOrEmpty(text) || !NeedsBidi(text)) return new[] { (0, text?.Length ?? 0, false) };
            var types = new Kind[text.Length];
            for (int i = 0; i < text.Length; i++) types[i] = Classify(text, i);

            // P2/P3: the first strong letter sets the paragraph direction.
            int paragraph = 0;
            foreach (var t in types)
            {
                if (t == Kind.L) break;
                if (t is Kind.R or Kind.AL) { paragraph = 1; break; }
            }

            var sor = paragraph == 1 ? Kind.R : Kind.L;
            ResolveWeak(types, sor);
            ResolvePairedBrackets(text, types, paragraph, sor);
            ResolveNeutrals(types, paragraph);

            // I1/I2: implicit levels.
            var levels = new int[text.Length];
            for (int i = 0; i < text.Length; i++)
            {
                levels[i] = paragraph == 0
                    ? types[i] switch { Kind.R => 1, Kind.AN or Kind.EN => 2, _ => 0 }
                    : types[i] switch { Kind.L or Kind.AN or Kind.EN => 2, _ => 1 };
            }

            // Level runs in logical order, then L2: reverse every sequence at or above each level, highest first.
            var runs = new List<(int Start, int Length, int Level)>();
            for (int i = 0; i < text.Length;)
            {
                int j = i;
                while (j < text.Length && levels[j] == levels[i]) j++;
                runs.Add((i, j - i, levels[i]));
                i = j;
            }

            // Levels here are 0–2, so the lowest odd level is 1.
            int max = 0;
            foreach (var run in runs) if (run.Level > max) max = run.Level;
            for (int level = max; level >= 1; level--)
            {
                for (int i = 0; i < runs.Count;)
                {
                    if (runs[i].Level < level) { i++; continue; }
                    int j = i;
                    while (j < runs.Count && runs[j].Level >= level) j++;
                    runs.Reverse(i, j - i);
                    i = j;
                }
            }

            var result = new List<(int, int, bool)>(runs.Count);
            foreach (var run in runs) result.Add((run.Start, run.Length, run.Level % 2 == 1));
            return result;
        }

        private static bool NeedsBidi(string text)
        {
            foreach (var c in text)
            {
                if (c is >= '\u0590' and <= '\u08FF' || c is >= '\uFB1D' and <= '\uFDFF' || c is >= '\uFE70' and <= '\uFEFF') return true;
            }

            return false;
        }

        private static Kind Classify(string text, int index)
        {
            var c = text[index];
            if (c is >= '0' and <= '9' || c is >= '\u06F0' and <= '\u06F9' || c is >= '\uFF10' and <= '\uFF19') return Kind.EN;
            if (c is >= '\u0660' and <= '\u0669' || c is '\u066B' or '\u066C') return Kind.AN;
            if (c is '+' or '-' or '\u2212') return Kind.ES;
            if (c is '#' or '$' or '%' or '\u00B0' or '\u066A' or '\u20AC' or '\u00A3' or '\u00A2' or '\u00A5') return Kind.ET;
            if (c is ',' or '.' or ':' or '/' or '\u060C' or '\u00A0') return Kind.CS;
            var category = char.GetUnicodeCategory(text, index);
            if (category is UnicodeCategory.NonSpacingMark or UnicodeCategory.EnclosingMark) return Kind.NSM;
            // Hebrew, N'Ko, Samaritan, Mandaic and Hebrew presentation forms: letters and Hebrew punctuation are R.
            if (c is >= '\u0590' and <= '\u05FF' || c is >= '\u07C0' and <= '\u089F' || c is >= '\uFB1D' and <= '\uFB4F')
                return char.IsLetter(c) || c is '\u05BE' or '\u05C0' or '\u05C3' or '\u05C6' ? Kind.R : Kind.ON;
            if (c is >= '\u0600' and <= '\u07BF' || c is >= '\u08A0' and <= '\u08FF' || c is >= '\uFB50' and <= '\uFDFF' || c is >= '\uFE70' and <= '\uFEFF')
                return char.IsLetter(c) || c == '\u061B' || c == '\u061F' ? Kind.AL : Kind.ON;
            if (char.IsLetter(c) || char.IsSurrogate(c) || category is UnicodeCategory.SpacingCombiningMark || char.IsDigit(c)) return Kind.L;
            return Kind.ON;
        }

        /// <summary>W1–W7: marks, numbers next to Arabic letters, separators inside numbers, terminators next to them.</summary>
        private static void ResolveWeak(Kind[] t, Kind sor)
        {
            // W1: a mark takes the type of the character before it.
            for (int i = 0; i < t.Length; i++) if (t[i] == Kind.NSM) t[i] = i == 0 ? sor : t[i - 1];
            // W2: a European number after an Arabic letter (nearest strong type) is an Arabic number. W3: AL is R.
            var last = sor;
            for (int i = 0; i < t.Length; i++)
            {
                if (t[i] is Kind.L or Kind.R or Kind.AL) last = t[i];
                else if (t[i] == Kind.EN && last == Kind.AL) t[i] = Kind.AN;
            }

            for (int i = 0; i < t.Length; i++) if (t[i] == Kind.AL) t[i] = Kind.R;
            // W4: one separator between two numbers of a kind joins them.
            for (int i = 1; i + 1 < t.Length; i++)
            {
                if (t[i] == Kind.ES && t[i - 1] == Kind.EN && t[i + 1] == Kind.EN) t[i] = Kind.EN;
                else if (t[i] == Kind.CS && t[i - 1] is Kind.EN or Kind.AN && t[i + 1] == t[i - 1]) t[i] = t[i - 1];
            }

            // W5: terminators next to a European number join it.
            for (int i = 0; i < t.Length; i++)
            {
                if (t[i] != Kind.ET) continue;
                int j = i;
                while (j < t.Length && t[j] == Kind.ET) j++;
                if ((i > 0 && t[i - 1] == Kind.EN) || (j < t.Length && t[j] == Kind.EN))
                    for (int k = i; k < j; k++) t[k] = Kind.EN;
                i = j - 1;
            }

            // W6: other separators and terminators are neutral.
            for (int i = 0; i < t.Length; i++) if (t[i] is Kind.ES or Kind.ET or Kind.CS) t[i] = Kind.ON;
            // W7: a European number after a left-to-right letter is left to right.
            last = sor;
            for (int i = 0; i < t.Length; i++)
            {
                if (t[i] is Kind.L or Kind.R) last = t[i];
                else if (t[i] == Kind.EN && last == Kind.L) t[i] = Kind.L;
            }
        }

        /// <summary>
        /// N0: a bracket pair ((), [], {}) resolves as one. A strong direction inside that matches the paragraph's wins;
        /// otherwise the opposite direction inside wins when it also comes before the opening bracket; else the
        /// paragraph's. A pair with nothing strong inside stays neutral. Numbers count as R.
        /// </summary>
        private static void ResolvePairedBrackets(string text, Kind[] t, int paragraph, Kind sor)
        {
            var embedding = paragraph == 1 ? Kind.R : Kind.L;
            var opposite = paragraph == 1 ? Kind.L : Kind.R;
            Kind? Strong(Kind k) => k is Kind.L ? Kind.L : k is Kind.R or Kind.EN or Kind.AN ? Kind.R : null;
            var stack = new List<(char Close, int Open)>();
            var pairs = new List<(int Open, int Close)>();
            for (int i = 0; i < text.Length; i++)
            {
                if (t[i] != Kind.ON) continue;
                var close = text[i] switch { '(' => ')', '[' => ']', '{' => '}', _ => '\0' };
                if (close != '\0')
                {
                    if (stack.Count == 63) break; // BD16: give up on deeper nesting
                    stack.Add((close, i));
                    continue;
                }

                for (int k = stack.Count - 1; k >= 0; k--)
                {
                    if (stack[k].Close != text[i]) continue;
                    pairs.Add((stack[k].Open, i));
                    stack.RemoveRange(k, stack.Count - k);
                    break;
                }
            }

            pairs.Sort((a, b) => a.Open.CompareTo(b.Open));
            foreach (var (open, close) in pairs)
            {
                bool hasEmbedding = false, hasOpposite = false;
                for (int i = open + 1; i < close; i++)
                {
                    var strong = Strong(t[i]);
                    if (strong == embedding) hasEmbedding = true;
                    else if (strong == opposite) hasOpposite = true;
                }

                Kind? resolved = null;
                if (hasEmbedding) resolved = embedding;
                else if (hasOpposite)
                {
                    var before = sor;
                    for (int i = open - 1; i >= 0; i--)
                    {
                        if (Strong(t[i]) is { } found) { before = found; break; }
                    }

                    resolved = before == opposite ? opposite : embedding;
                }

                if (resolved is { } direction) t[open] = t[close] = direction;
            }
        }

        /// <summary>N1/N2: a neutral run between two of the same direction (numbers count as R) takes it, else the paragraph's.</summary>
        private static void ResolveNeutrals(Kind[] t, int paragraph)
        {
            var embedding = paragraph == 1 ? Kind.R : Kind.L;
            Kind Strong(Kind k) => k is Kind.EN or Kind.AN ? Kind.R : k;
            for (int i = 0; i < t.Length; i++)
            {
                if (t[i] != Kind.ON) continue;
                int j = i;
                while (j < t.Length && t[j] == Kind.ON) j++;
                var before = i == 0 ? embedding : Strong(t[i - 1]);
                var after = j == t.Length ? embedding : Strong(t[j]);
                var resolved = before == after ? before : embedding;
                for (int k = i; k < j; k++) t[k] = resolved;
                i = j - 1;
            }
        }
    }
}
