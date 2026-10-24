using System;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Small deterministic matchers for the fixed request grammars (title keys, feed keys, ntfy topics, calendar days, branding
    /// file names): one pass over a bounded input, no regular expression and no clock, so a valid request is accepted however
    /// long the server takes to schedule it. A regular expression with a match timeout fails a valid input under load.
    /// </summary>
    internal static class AsciiGrammar
    {
        /// <summary>An ASCII digit (0-9), never another script's digit.</summary>
        public static bool IsDigit(char c) => c is >= '0' and <= '9';

        /// <summary>True when <paramref name="text"/> is <paramref name="min"/> to <paramref name="max"/> ASCII digits.</summary>
        public static bool IsDigits(ReadOnlySpan<char> text, int min, int max)
        {
            if (text.Length < min || text.Length > max) return false;
            for (var i = 0; i < text.Length; i++)
            {
                if (!IsDigit(text[i])) return false;
            }
            return true;
        }

        /// <summary>The length of the run of ASCII digits at the start of <paramref name="text"/>.</summary>
        public static int DigitRun(ReadOnlySpan<char> text)
        {
            var n = 0;
            while (n < text.Length && IsDigit(text[n])) n++;
            return n;
        }

        /// <summary>
        /// A number without a leading zero ("0" itself only when <paramref name="zero"/>): 1 to <paramref name="max"/> digits.
        /// </summary>
        public static bool IsPlainNumber(ReadOnlySpan<char> text, int max, bool zero)
        {
            if (!IsDigits(text, 1, max)) return false;
            return text[0] != '0' || (zero && text.Length == 1);
        }

        /// <summary>
        /// True when <paramref name="text"/> starts with <paramref name="lower"/> (ASCII lower case) in either case.
        /// <paramref name="culture"/>: also the two non-ASCII letters the culture-sensitive case-insensitive matching of the
        /// branding names always treated as the same letter (the dotted capital I for i, the Kelvin sign for k).
        /// </summary>
        public static bool StartsWithIgnoreCase(ReadOnlySpan<char> text, string lower, bool culture = false)
        {
            if (text.Length < lower.Length) return false;
            for (var i = 0; i < lower.Length; i++)
            {
                if (!SameLetter(text[i], lower[i], culture)) return false;
            }
            return true;
        }

        /// <summary>True when <paramref name="text"/> ends with <paramref name="lower"/> (see <see cref="StartsWithIgnoreCase"/>).</summary>
        public static bool EndsWithIgnoreCase(ReadOnlySpan<char> text, string lower, bool culture = false)
            => text.Length >= lower.Length && StartsWithIgnoreCase(text[(text.Length - lower.Length)..], lower, culture);

        /// <summary>True when <paramref name="text"/> is <paramref name="lower"/> (see <see cref="StartsWithIgnoreCase"/>).</summary>
        public static bool EqualsIgnoreCase(ReadOnlySpan<char> text, string lower, bool culture = false)
            => text.Length == lower.Length && StartsWithIgnoreCase(text, lower, culture);

        /// <summary>A day's shape, <c>dddd-dd-dd</c> in ASCII digits and nothing else (no calendar check: 2026-02-31 passes).</summary>
        public static bool IsDayShape(string? text)
            => text is { Length: 10 } && text[4] == '-' && text[7] == '-'
                && IsDigits(text.AsSpan(0, 4), 4, 4) && IsDigits(text.AsSpan(5, 2), 2, 2) && IsDigits(text.AsSpan(8, 2), 2, 2);

        /// <summary>An IMDb id as Seerr gives it: <c>tt</c> (lower case) and 1 to <paramref name="maxDigits"/> ASCII digits.</summary>
        public static bool IsImdb(string? text, int maxDigits)
            => text != null && text.StartsWith("tt", StringComparison.Ordinal) && IsDigits(text.AsSpan(2), 1, maxDigits);

        /// <summary>An ASCII hexadecimal digit, either case.</summary>
        public static bool IsHex(char c) => IsDigit(c) || c is >= 'a' and <= 'f' or >= 'A' and <= 'F';

        private static bool SameLetter(char c, char lower, bool culture)
        {
            if (c == lower) return true;
            if (lower is >= 'a' and <= 'z' && c == (char)(lower - 32)) return true;
            return culture && ((lower == 'i' && c == '\u0130') || (lower == 'k' && c == '\u212A'));
        }
    }
}
