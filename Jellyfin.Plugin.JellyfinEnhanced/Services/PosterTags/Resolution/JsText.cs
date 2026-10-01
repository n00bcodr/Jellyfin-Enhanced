using System;
using System.Collections.Frozen;
using System.Collections.Generic;
using System.Globalization;
using System.Numerics;
using System.Text;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution
{
    /// <summary>
    /// JavaScript string and number semantics the web tag code relies on (String.prototype.trim,
    /// toLowerCase, toUpperCase, Number.prototype.toFixed, Math.round), reproduced exactly so the
    /// native resolver makes the same decisions as the browser.
    /// </summary>
    internal static class JsText
    {
        private static readonly FrozenDictionary<char, string> UpperSpecial = ParseCaseTable(ResolutionData.UpperCaseSpecial);
        private static readonly FrozenDictionary<char, string> LowerSpecial = ParseCaseTable(ResolutionData.LowerCaseSpecial);
        private static readonly (int[] Starts, int[] Ends) Cased = ParseRanges(ResolutionData.CasedRanges);
        private static readonly (int[] Starts, int[] Ends) CaseIgnorable = ParseRanges(ResolutionData.CaseIgnorableRanges);

        private const char CapitalSigma = '\u03a3';
        private const char SmallSigma = '\u03c3';
        private const char FinalSigma = '\u03c2';
        private const char DotlessSmallI = '\u0131';

        /// <summary>Object.prototype property names: plain-object lookups in the web code find these on any object.</summary>
        internal static readonly FrozenSet<string> ObjectPrototypeKeys = new[]
        {
            "constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__",
            "__lookupSetter__", "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "__proto__",
            "toLocaleString",
        }.ToFrozenSet(StringComparer.Ordinal);

        /// <summary>JS WhiteSpace + LineTerminator (what trim() strips and \s matches).</summary>
        internal static bool IsJsWhiteSpace(char c) => c switch
        {
            '\t' or '\n' or '\v' or '\f' or '\r' or ' ' or '\u00a0' or '\u1680' or '\u2028' or '\u2029'
                or '\u202f' or '\u205f' or '\u3000' or '\ufeff' => true,
            _ => c >= '\u2000' && c <= '\u200a',
        };

        /// <summary>String.prototype.trim().</summary>
        internal static string Trim(string value)
        {
            var start = 0;
            var end = value.Length - 1;
            while (start <= end && IsJsWhiteSpace(value[start])) start++;
            while (end >= start && IsJsWhiteSpace(value[end])) end--;
            return start == 0 && end == value.Length - 1 ? value : value.Substring(start, end - start + 1);
        }

        /// <summary>
        /// String.prototype.toLowerCase(): the full mapping over Unicode scalars (supplementary-plane
        /// letters included, multi-unit SpecialCasing expansions), with the one contextual rule the
        /// root locale applies, Final_Sigma. Lone surrogates are kept.
        /// </summary>
        internal static string ToLower(string value)
        {
            if (IsAsciiLowerAlready(value)) return value;
            StringBuilder? sb = null;
            for (var i = 0; i < value.Length; i++)
            {
                var c = value[i];
                if (c < 0x80)
                {
                    if (c >= 'A' && c <= 'Z') (sb ??= Start(value, i)).Append((char)(c + 32));
                    else sb?.Append(c);
                    continue;
                }

                if (char.IsHighSurrogate(c) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]))
                {
                    var rune = new Rune(c, value[i + 1]);
                    var lowerRune = Rune.ToLowerInvariant(rune);
                    if (lowerRune != rune) AppendRune(sb ??= Start(value, i), lowerRune);
                    else sb?.Append(c).Append(value[i + 1]);
                    i++;
                    continue;
                }

                if (c == CapitalSigma)
                {
                    (sb ??= Start(value, i)).Append(IsFinalSigma(value, i) ? FinalSigma : SmallSigma);
                    continue;
                }

                if (LowerSpecial.TryGetValue(c, out var special))
                {
                    (sb ??= Start(value, i)).Append(special);
                    continue;
                }

                var lower = char.ToLowerInvariant(c);
                if (lower != c) (sb ??= Start(value, i)).Append(lower);
                else sb?.Append(c);
            }

            return sb?.ToString() ?? value;
        }

        /// <summary>
        /// String.prototype.toUpperCase(): the full mapping over Unicode scalars (e.g. sharp s becomes
        /// "SS", supplementary-plane letters are mapped). Lone surrogates are kept.
        /// </summary>
        internal static string ToUpper(string value)
        {
            StringBuilder? sb = null;
            for (var i = 0; i < value.Length; i++)
            {
                var c = value[i];
                if (c < 0x80)
                {
                    if (c >= 'a' && c <= 'z') (sb ??= Start(value, i)).Append((char)(c - 32));
                    else sb?.Append(c);
                    continue;
                }

                if (char.IsHighSurrogate(c) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]))
                {
                    var rune = new Rune(c, value[i + 1]);
                    var upperRune = Rune.ToUpperInvariant(rune);
                    if (upperRune != rune) AppendRune(sb ??= Start(value, i), upperRune);
                    else sb?.Append(c).Append(value[i + 1]);
                    i++;
                    continue;
                }

                if (UpperSpecial.TryGetValue(c, out var special))
                {
                    (sb ??= Start(value, i)).Append(special);
                    continue;
                }

                if (c == DotlessSmallI)
                {
                    // .NET's invariant casing leaves the Turkish dotless i alone; Unicode maps it to I.
                    (sb ??= Start(value, i)).Append('I');
                    continue;
                }

                var upper = char.ToUpperInvariant(c);
                if (upper != c) (sb ??= Start(value, i)).Append(upper);
                else sb?.Append(c);
            }

            return sb?.ToString() ?? value;
        }

        /// <summary>
        /// ASCII-only lowercase. Equivalent to JS for matching ASCII patterns: a case-insensitive
        /// (non-unicode) JS regex never folds a non-ASCII character onto an ASCII one, and none of the
        /// quality-tag substrings contain the only letters ('i', 'k') a non-ASCII JS lowercase can produce.
        /// </summary>
        internal static string AsciiLower(string? value)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;
            if (IsAsciiLowerAlready(value)) return value;
            return string.Create(value.Length, value, static (span, source) =>
            {
                for (var i = 0; i < source.Length; i++)
                {
                    var c = source[i];
                    span[i] = c >= 'A' && c <= 'Z' ? (char)(c + 32) : c;
                }
            });
        }

        /// <summary>
        /// Number.prototype.toFixed(digits): for finite |x| &lt; 1e21 rounds the exact binary value,
        /// ties to the larger magnitude; otherwise it is the number's string form (Number::toString:
        /// "Infinity", "NaN", "1e+21").
        /// </summary>
        internal static string ToFixed(double x, int digits)
        {
            if (!double.IsFinite(x) || Math.Abs(x) >= 1e21)
            {
                return NumberToString(x);
            }

            var negative = x < 0;
            var bits = BitConverter.DoubleToInt64Bits(Math.Abs(x));
            var exponent = (int)((bits >> 52) & 0x7FF);
            var mantissa = bits & 0xFFFFFFFFFFFFFL;
            if (exponent == 0) exponent++;
            else mantissa |= 1L << 52;
            exponent -= 1075; // |x| = mantissa * 2^exponent

            // n = round-half-up(|x| * 10^digits), exactly.
            var scaled = new BigInteger(mantissa) * BigInteger.Pow(10, digits);
            BigInteger n;
            if (exponent >= 0)
            {
                n = scaled << exponent;
            }
            else
            {
                var denominator = BigInteger.One << -exponent;
                n = ((scaled << 1) + denominator) / (denominator << 1);
            }

            var text = n.ToString(CultureInfo.InvariantCulture);
            if (digits > 0)
            {
                if (text.Length <= digits) text = new string('0', digits - text.Length + 1) + text;
                text = text.Substring(0, text.Length - digits) + "." + text.Substring(text.Length - digits);
            }

            // JS keeps the sign of a negative value that rounds to zero ("-0.0").
            return negative ? "-" + text : text;
        }

        /// <summary>
        /// Number::toString(x) for NaN, the infinities and |x| &gt;= 1e21, the only values the web's
        /// formatting reaches it with. Both runtimes pick the shortest round-trip digits; JS writes
        /// the exponent as "e+21" where .NET writes "E+21".
        /// </summary>
        internal static string NumberToString(double x)
        {
            if (double.IsNaN(x)) return "NaN";
            if (double.IsPositiveInfinity(x)) return "Infinity";
            if (double.IsNegativeInfinity(x)) return "-Infinity";
            if (Math.Abs(x) < 1e21) throw new ArgumentOutOfRangeException(nameof(x), x, "Only NaN, infinities and |x| >= 1e21 are supported.");
            return x.ToString("R", CultureInfo.InvariantCulture).Replace('E', 'e');
        }

        /// <summary>Math.round: nearest integer, ties towards +infinity.</summary>
        internal static double MathRound(double x)
        {
            if (double.IsNaN(x) || double.IsInfinity(x)) return x;
            var floor = Math.Floor(x);
            return x - floor >= 0.5 ? floor + 1 : floor;
        }

        /// <summary>
        /// The number a JSON float written by System.Text.Json (shortest round-trip form) parses to
        /// in JavaScript. Widening the float directly would give a different double.
        /// </summary>
        internal static double FloatAsJsNumber(float value)
        {
            Span<char> buffer = stackalloc char[32];
            if (value.TryFormat(buffer, out var written, "R", CultureInfo.InvariantCulture))
            {
                return double.Parse(buffer[..written], NumberStyles.Float, CultureInfo.InvariantCulture);
            }

            return value;
        }

        private static bool IsAsciiLowerAlready(string value)
        {
            foreach (var c in value)
            {
                if (c >= 0x80 || (c >= 'A' && c <= 'Z')) return false;
            }

            return true;
        }

        private static StringBuilder Start(string value, int index) => new StringBuilder(value.Length + 8).Append(value, 0, index);

        private static void AppendRune(StringBuilder sb, Rune rune)
        {
            Span<char> units = stackalloc char[2];
            sb.Append(units[..rune.EncodeToUtf16(units)]);
        }

        /// <summary>
        /// Unicode Final_Sigma (as ICU applies it): the capital sigma at <paramref name="index"/> is
        /// preceded by a cased letter, skipping case-ignorable characters, and not followed by one.
        /// A character that is both case-ignorable and cased counts as case-ignorable.
        /// </summary>
        private static bool IsFinalSigma(string value, int index)
        {
            var before = false;
            for (var i = index; i > 0;)
            {
                var status = Rune.DecodeLastFromUtf16(value.AsSpan(0, i), out var rune, out var consumed);
                i -= consumed;
                var cp = status == System.Buffers.OperationStatus.Done ? rune.Value : value[i];
                if (InRanges(CaseIgnorable, cp)) continue;
                before = InRanges(Cased, cp);
                break;
            }

            if (!before) return false;
            for (var i = index + 1; i < value.Length;)
            {
                var status = Rune.DecodeFromUtf16(value.AsSpan(i), out var rune, out var consumed);
                var cp = status == System.Buffers.OperationStatus.Done ? rune.Value : value[i];
                i += consumed;
                if (InRanges(CaseIgnorable, cp)) continue;
                return !InRanges(Cased, cp);
            }

            return true;
        }

        private static bool InRanges((int[] Starts, int[] Ends) ranges, int cp)
        {
            var i = Array.BinarySearch(ranges.Starts, cp);
            if (i >= 0) return true;
            i = ~i - 1;
            return i >= 0 && cp <= ranges.Ends[i];
        }

        private static (int[] Starts, int[] Ends) ParseRanges(string data)
        {
            var list = new List<(int Start, int End)>();
            foreach (var (start, end) in ParseTable(data))
            {
                list.Add((int.Parse(start, NumberStyles.HexNumber, CultureInfo.InvariantCulture), int.Parse(end, NumberStyles.HexNumber, CultureInfo.InvariantCulture)));
            }

            list.Sort((a, b) => a.Start.CompareTo(b.Start));
            return (list.ConvertAll(r => r.Start).ToArray(), list.ConvertAll(r => r.End).ToArray());
        }

        private static FrozenDictionary<char, string> ParseCaseTable(string data)
        {
            var map = new Dictionary<char, string>();
            foreach (var (key, value) in ParseTable(data))
            {
                map[key[0]] = value;
            }

            return map.ToFrozenDictionary();
        }

        /// <summary>Splits a generated "key TAB value" table.</summary>
        internal static IEnumerable<(string Key, string Value)> ParseTable(string data)
        {
            foreach (var line in data.Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                var tab = line.IndexOf('\t');
                if (tab > 0) yield return (line.Substring(0, tab), line.Substring(tab + 1));
            }
        }
    }
}
