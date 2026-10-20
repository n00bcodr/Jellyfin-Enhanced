using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Collages
{
    /// <summary>
    /// A collage marker as the older (experimental) collage feature wrote it: one unversioned JSON object per list.
    /// </summary>
    /// <param name="ListId">The list id ("N").</param>
    /// <param name="ImagePath">The image path it recorded.</param>
    /// <param name="Sha256">The recorded image's SHA-256 (lowercase hex).</param>
    /// <param name="PosterKeys">The poster paths it was drawn from.</param>
    /// <param name="FailedKeys">Poster paths that failed for good.</param>
    /// <param name="SetAt">When it was set (as written).</param>
    /// <param name="PendingSha256">The SHA-256 of a write that was never recorded.</param>
    /// <param name="PendingPosterKeys">That write's poster paths.</param>
    public sealed record ListCollageLegacyMarker(
        string ListId,
        string ImagePath,
        string Sha256,
        IReadOnlyList<string> PosterKeys,
        IReadOnlyList<string> FailedKeys,
        string SetAt,
        string? PendingSha256,
        IReadOnlyList<string>? PendingPosterKeys);

    /// <summary>What reading a marker gave.</summary>
    public enum ListCollageLegacyParseStatus
    {
        /// <summary>A recorded image path and hash.</summary>
        Valid = 0,

        /// <summary>Only a pending write's hash (no recorded image).</summary>
        PendingOnly = 1,

        /// <summary>Neither a complete recorded image nor a pending write.</summary>
        NoEvidence = 2,

        /// <summary>Not the marker's JSON shape.</summary>
        Malformed = 3,

        /// <summary>Over a size, count or length bound.</summary>
        TooLarge = 4,

        /// <summary>Another list's marker.</summary>
        WrongList = 5,

        /// <summary>A field the marker never had (a different or newer format).</summary>
        UnknownSchema = 6,

        /// <summary>A hash that isn't lowercase SHA-256 hex.</summary>
        InvalidHash = 7,

        /// <summary>A path that isn't one exact absolute path (relative, dot segments, other separators, control characters).</summary>
        InvalidPath = 8,
    }

    /// <summary>A parse result: the status and, for <see cref="ListCollageLegacyParseStatus.Valid"/> or pending-only, the marker.</summary>
    /// <param name="Status">The status.</param>
    /// <param name="Marker">The marker read (Valid or PendingOnly), else null.</param>
    public sealed record ListCollageLegacyParse(ListCollageLegacyParseStatus Status, ListCollageLegacyMarker? Marker);

    /// <summary>
    /// The list's current primary image, as the owner of native image facts read it.
    /// </summary>
    /// <param name="Present">Whether the list has a primary image.</param>
    /// <param name="ImagePath">Its path.</param>
    /// <param name="Sha256">The SHA-256 (lowercase hex) of its current content, or null when it couldn't be hashed.</param>
    /// <param name="PathExact">Whether the path was resolved exactly (no link or other indirection between them).</param>
    public sealed record ListCollageNativePrimaryEvidence(bool Present, string? ImagePath, string? Sha256, bool PathExact);

    /// <summary>Owner-held, positive proof that the list's current image replaced an old collage (never inferred from looks or a hash difference).</summary>
    public sealed record ListCollageSupersession
    {
        /// <summary>Records the proof.</summary>
        /// <param name="evidence">What proves it.</param>
        public ListCollageSupersession(string evidence)
        {
            if (string.IsNullOrWhiteSpace(evidence))
            {
                throw new ArgumentException("Supersession needs evidence.", nameof(evidence));
            }

            Evidence = evidence;
        }

        /// <summary>Gets what proves it.</summary>
        public string Evidence { get; }
    }

    /// <summary>What may happen to the list's current image on every delivery path. Nothing is ever deleted, replaced or adopted.</summary>
    public enum ListCollageLegacyDelivery
    {
        /// <summary>The list has no image of its own: nothing legacy can be served.</summary>
        NoNativePrimary = 0,

        /// <summary>No legacy association: the image goes through the normal native path unchanged.</summary>
        NativeUnchanged = 1,

        /// <summary>The image is the old collage (exact path and content): withhold it and its derivatives everywhere.</summary>
        WithholdLegacy = 2,

        /// <summary>An imported list's image can't be classified: withhold it (the file is kept).</summary>
        QuarantineUncertain = 3,

        /// <summary>Positively proven to have replaced the old collage: normal native path.</summary>
        NativeSupersedes = 4,
    }

    /// <summary>
    /// Reads the collage markers the experimental-list import copied and classifies what the list's current image may do.
    /// Takes bytes, not paths; no file, network or image access. An exact recorded path + content match is old collage
    /// pixels to withhold; anything else connected with a legacy collage is uncertain and quarantined unless the image is
    /// positively proven to supersede it; lists with no legacy connection are unchanged. Never a reason to delete or
    /// adopt anything, and never decided by dimensions, folder or age.
    /// </summary>
    public static class ListCollageLegacyEvidence
    {
        /// <summary>Largest marker read, in bytes.</summary>
        public const int MaxBytes = 16 * 1024;

        /// <summary>Most entries in one array.</summary>
        public const int MaxArrayItems = 64;

        /// <summary>Longest string.</summary>
        public const int MaxStringLength = 1024;

        private const int MaxDepth = 3;

        private static readonly HashSet<string> KnownFields = new(StringComparer.Ordinal)
        {
            "listId", "imagePath", "sha256", "posterKeys", "failedKeys", "setAt", "pendingSha256", "pendingPosterKeys",
        };

        private static readonly Regex ListIdPattern = new("^[0-9a-f]{32}$", RegexOptions.CultureInvariant);
        private static readonly Regex HashPattern = new("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);

        /// <summary>Reads one marker.</summary>
        /// <param name="json">The marker's bytes (UTF-8 JSON).</param>
        /// <param name="expectedListIdN">The list the marker was stored for ("N").</param>
        /// <returns>The result.</returns>
        public static ListCollageLegacyParse Parse(ReadOnlySpan<byte> json, string expectedListIdN)
        {
            if (expectedListIdN == null || !ListIdPattern.IsMatch(expectedListIdN))
            {
                throw new ArgumentException("List id must be 32 lowercase hex characters.", nameof(expectedListIdN));
            }

            if (json.Length > MaxBytes)
            {
                return Fail(ListCollageLegacyParseStatus.TooLarge);
            }

            Dictionary<string, object?> fields;
            try
            {
                var status = ReadFields(json, out fields);
                if (status != null)
                {
                    return Fail(status.Value);
                }
            }
            catch (JsonException)
            {
                return Fail(ListCollageLegacyParseStatus.Malformed);
            }

            if (fields.Keys.Any(k => !KnownFields.Contains(k)))
            {
                return Fail(ListCollageLegacyParseStatus.UnknownSchema);
            }

            if (!TryString(fields, "listId", required: true, out var listId) || !TryString(fields, "imagePath", false, out var imagePath)
                || !TryString(fields, "sha256", false, out var sha) || !TryString(fields, "setAt", false, out var setAt)
                || !TryNullableString(fields, "pendingSha256", out var pendingSha)
                || !TryList(fields, "posterKeys", nullable: false, out var posterKeys) || !TryList(fields, "failedKeys", false, out var failedKeys)
                || !TryList(fields, "pendingPosterKeys", nullable: true, out var pendingKeys))
            {
                return Fail(ListCollageLegacyParseStatus.Malformed);
            }

            if (!string.Equals(listId, expectedListIdN, StringComparison.Ordinal))
            {
                return Fail(ListCollageLegacyParseStatus.WrongList);
            }

            if ((sha!.Length > 0 && !HashPattern.IsMatch(sha)) || (!string.IsNullOrEmpty(pendingSha) && !HashPattern.IsMatch(pendingSha)))
            {
                return Fail(ListCollageLegacyParseStatus.InvalidHash);
            }

            if (imagePath!.Length > 0 && !IsExactAbsolutePath(imagePath))
            {
                return Fail(ListCollageLegacyParseStatus.InvalidPath);
            }

            var marker = new ListCollageLegacyMarker(listId!, imagePath, sha, posterKeys!, failedKeys!, setAt!, string.IsNullOrEmpty(pendingSha) ? null : pendingSha, pendingKeys);
            if (imagePath.Length > 0 && sha.Length > 0)
            {
                return new ListCollageLegacyParse(ListCollageLegacyParseStatus.Valid, marker);
            }

            return marker.PendingSha256 != null
                ? new ListCollageLegacyParse(ListCollageLegacyParseStatus.PendingOnly, marker)
                : Fail(ListCollageLegacyParseStatus.NoEvidence);
        }

        /// <summary>Classifies what the list's current primary image may do.</summary>
        /// <param name="marker">The list's marker as read (null: none).</param>
        /// <param name="native">The list's current primary image.</param>
        /// <param name="legacyImportCandidate">Whether the list came from the experimental import with a collage marker.</param>
        /// <param name="supersession">Positive proof the current image replaced the old collage, if any.</param>
        /// <returns>The delivery classification.</returns>
        public static ListCollageLegacyDelivery Classify(ListCollageLegacyParse? marker, ListCollageNativePrimaryEvidence native, bool legacyImportCandidate, ListCollageSupersession? supersession)
        {
            ArgumentNullException.ThrowIfNull(native);
            if (!native.Present)
            {
                return ListCollageLegacyDelivery.NoNativePrimary;
            }

            if (marker is { Status: ListCollageLegacyParseStatus.Valid, Marker: { } recorded }
                && native.PathExact
                && native.ImagePath != null
                && string.Equals(native.ImagePath, recorded.ImagePath, StringComparison.Ordinal)
                && native.Sha256 != null
                && string.Equals(native.Sha256, recorded.Sha256, StringComparison.Ordinal))
            {
                return ListCollageLegacyDelivery.WithholdLegacy;
            }

            if (marker == null && !legacyImportCandidate)
            {
                return ListCollageLegacyDelivery.NativeUnchanged;
            }

            return supersession != null ? ListCollageLegacyDelivery.NativeSupersedes : ListCollageLegacyDelivery.QuarantineUncertain;
        }

        private static ListCollageLegacyParse Fail(ListCollageLegacyParseStatus status) => new(status, null);

        // One flat object of strings, nulls and arrays of strings; duplicates, nesting and oversize values are refused.
        private static ListCollageLegacyParseStatus? ReadFields(ReadOnlySpan<byte> json, out Dictionary<string, object?> fields)
        {
            fields = new Dictionary<string, object?>(StringComparer.Ordinal);
            var reader = new Utf8JsonReader(json, new JsonReaderOptions { MaxDepth = MaxDepth, CommentHandling = JsonCommentHandling.Disallow, AllowTrailingCommas = false });
            if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject)
            {
                return ListCollageLegacyParseStatus.Malformed;
            }

            while (reader.Read())
            {
                if (reader.TokenType == JsonTokenType.EndObject)
                {
                    // Anything after the object (other than whitespace) is not this format.
                    return reader.Read() ? ListCollageLegacyParseStatus.Malformed : null;
                }

                if (reader.TokenType != JsonTokenType.PropertyName)
                {
                    return ListCollageLegacyParseStatus.Malformed;
                }

                var name = reader.GetString()!;
                if (name.Length > MaxStringLength)
                {
                    return ListCollageLegacyParseStatus.TooLarge;
                }

                if (!reader.Read())
                {
                    return ListCollageLegacyParseStatus.Malformed;
                }

                object? value;
                switch (reader.TokenType)
                {
                    case JsonTokenType.Null:
                        value = null;
                        break;
                    case JsonTokenType.String:
                        var text = reader.GetString()!;
                        if (text.Length > MaxStringLength)
                        {
                            return ListCollageLegacyParseStatus.TooLarge;
                        }

                        value = text;
                        break;
                    case JsonTokenType.StartArray:
                        var items = new List<string>();
                        while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
                        {
                            if (reader.TokenType != JsonTokenType.String)
                            {
                                return ListCollageLegacyParseStatus.Malformed;
                            }

                            var item = reader.GetString()!;
                            if (item.Length > MaxStringLength || items.Count == MaxArrayItems)
                            {
                                return ListCollageLegacyParseStatus.TooLarge;
                            }

                            items.Add(item);
                        }

                        if (reader.TokenType != JsonTokenType.EndArray)
                        {
                            return ListCollageLegacyParseStatus.Malformed;
                        }

                        value = items;
                        break;
                    default:
                        value = new UnsupportedValue();
                        reader.Skip();
                        break;
                }

                if (!fields.TryAdd(name, value))
                {
                    return ListCollageLegacyParseStatus.Malformed;
                }
            }

            return ListCollageLegacyParseStatus.Malformed;
        }

        private static bool TryString(Dictionary<string, object?> fields, string name, bool required, out string? value)
        {
            if (!fields.TryGetValue(name, out var raw))
            {
                value = string.Empty;
                return !required;
            }

            value = raw as string;
            return value != null;
        }

        private static bool TryNullableString(Dictionary<string, object?> fields, string name, out string? value)
        {
            value = null;
            if (!fields.TryGetValue(name, out var raw) || raw == null)
            {
                return true;
            }

            value = raw as string;
            return value != null;
        }

        private static bool TryList(Dictionary<string, object?> fields, string name, bool nullable, out IReadOnlyList<string>? value)
        {
            value = nullable ? null : Array.Empty<string>();
            if (!fields.TryGetValue(name, out var raw) || (raw == null && nullable))
            {
                return true;
            }

            value = raw as List<string>;
            return value != null;
        }

        // One absolute POSIX path, spelled exactly: no relative or dot segments, empty segments, trailing separator,
        // backslashes, home shorthand or control/format characters that could make two spellings mean one file.
        private static bool IsExactAbsolutePath(string path)
        {
            if (path.Length < 2 || path[0] != '/' || path[^1] == '/' || path.Contains('\\', StringComparison.Ordinal))
            {
                return false;
            }

            foreach (var c in path)
            {
                var category = char.GetUnicodeCategory(c);
                if (category is UnicodeCategory.Control or UnicodeCategory.Format or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator
                    or UnicodeCategory.Surrogate or UnicodeCategory.OtherNotAssigned)
                {
                    return false;
                }
            }

            foreach (var segment in path[1..].Split('/'))
            {
                if (segment.Length == 0 || segment == "." || segment == ".." || segment == "~")
                {
                    return false;
                }
            }

            return true;
        }

        // A JSON number, boolean or object where the marker only ever had strings and string arrays.
        private sealed class UnsupportedValue
        {
        }
    }
}
