using System;
using System.Buffers;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using Jellyfin.Data.Enums;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>What <see cref="LegacyCollageProjection.Project"/> did with a payload.</summary>
    internal enum LegacyCollageProjected
    {
        /// <summary>Nothing in it was withheld: the payload goes as it was, byte for byte.</summary>
        Unchanged = 0,

        /// <summary>Withheld image fields were taken out; every other byte of the payload is as it was.</summary>
        Changed = 1,

        /// <summary>Not one JSON value (or deeper than JSON answers go): nothing could be checked.</summary>
        NotJson = 2,
    }

    /// <summary>One change the projection makes to a payload: the bytes from <see cref="Start"/> to <see cref="End"/> are
    /// dropped, or (<see cref="False"/>) replaced by <c>false</c>. Positions are in the payload's UTF-8 bytes.</summary>
    internal readonly record struct LegacyCollageEdit(long Start, long End, bool False);

    /// <summary>
    /// The one projection that takes withheld legacy collages (and the library tiles built from them) out of whatever a
    /// client is sent as JSON, at the serialization boundary of every delivery path: MVC response bodies of any result
    /// type (<see cref="LegacyCollageBody"/>) and WebSocket messages (<see cref="LegacyCollageSockets"/>). It works on the
    /// payload's own bytes and keeps its structure:
    /// <list type="bullet">
    /// <item>Only the recognized image fields below are touched, by their exact spelling: the host's (PascalCase) and its
    /// camelCase profile's (<see cref="Fields"/>). Image types inside <c>ImageTags</c>/<c>ImageBlurHashes</c> are the
    /// host's enum names in both profiles. Every other key, value, order and byte is copied as it was, so a payload
    /// with nothing withheld is sent byte for byte (duplicate or case-variant keys included), and one with something
    /// withheld loses just those members (each with one separator).</item>
    /// <item>An object whose <c>Id</c> names an item that withholds its own image of a type loses <c>ImageTags</c> and
    /// <c>ImageBlurHashes</c> of that type; for Primary also <c>PrimaryImageAspectRatio</c> and <c>PrimaryImageTag</c>,
    /// and <c>HasPrimaryImage</c> becomes false; for Thumb <c>HasThumbImage</c> becomes false.</item>
    /// <item>A reference to another item's withheld image loses the reference, its tag and its blur hash:
    /// <c>ParentPrimaryImageItemId</c>/<c>ParentPrimaryImageTag</c>, <c>ParentThumbItemId</c>/<c>ParentThumbImageTag</c>,
    /// a search hint's <c>ThumbImageItemId</c>/<c>ThumbImageTag</c>.</item>
    /// <item>It is incremental: one pass of the reader decides, object by object as each one closes, which bytes go
    /// (<see cref="Decide(Stream, LegacyCollageView)"/>), keeping only the recognized members of the objects still open,
    /// so a payload of any size is checked in bounded memory; a second pass copies it with those edits.</item>
    /// <item>It never throws on a payload: one that isn't JSON comes back as <see cref="LegacyCollageProjected.NotJson"/>
    /// and each caller decides (a JSON answer that can't be checked is not sent).</item>
    /// </list>
    /// Every other image reference names an image type no collage was drawn into or an item that is never a list or a
    /// library tile.
    /// </summary>
    internal static class LegacyCollageProjection
    {
        /// <summary>Item kinds besides lists whose own tile the host composes from list images (when their collection type is
        /// playlists or boxsets).</summary>
        internal static readonly HashSet<BaseItemKind> HolderKinds = new() { BaseItemKind.CollectionFolder, BaseItemKind.UserView, BaseItemKind.ManualPlaylistsFolder };

        /// <summary>Deepest payload checked (the host writes at most 64 levels).</summary>
        internal const int MaxDepth = 256;

        /// <summary>The fields the projection recognizes, by their exact spellings (host, camelCase profile).</summary>
        internal static readonly IReadOnlyList<(Field Field, string Pascal, string Camel)> Fields = new[]
        {
            (Field.Id, "Id", "id"),
            (Field.Type, "Type", "type"),
            (Field.CollectionType, "CollectionType", "collectionType"),
            (Field.ImageTags, "ImageTags", "imageTags"),
            (Field.ImageBlurHashes, "ImageBlurHashes", "imageBlurHashes"),
            (Field.PrimaryImageAspectRatio, "PrimaryImageAspectRatio", "primaryImageAspectRatio"),
            (Field.PrimaryImageTag, "PrimaryImageTag", "primaryImageTag"),
            (Field.HasPrimaryImage, "HasPrimaryImage", "hasPrimaryImage"),
            (Field.HasThumbImage, "HasThumbImage", "hasThumbImage"),
            (Field.ParentPrimaryImageItemId, "ParentPrimaryImageItemId", "parentPrimaryImageItemId"),
            (Field.ParentPrimaryImageTag, "ParentPrimaryImageTag", "parentPrimaryImageTag"),
            (Field.ParentThumbItemId, "ParentThumbItemId", "parentThumbItemId"),
            (Field.ParentThumbImageTag, "ParentThumbImageTag", "parentThumbImageTag"),
            (Field.ThumbImageItemId, "ThumbImageItemId", "thumbImageItemId"),
            (Field.ThumbImageTag, "ThumbImageTag", "thumbImageTag"),
            // Image types as dictionary keys: the host writes enum names in both profiles (no dictionary key policy).
            (Field.Primary, "Primary", "Primary"),
            (Field.Thumb, "Thumb", "Thumb"),
        };

        private static readonly (Field Id, Field Tag, ImageType Type)[] References =
        {
            (Field.ParentPrimaryImageItemId, Field.ParentPrimaryImageTag, ImageType.Primary),
            (Field.ParentThumbItemId, Field.ParentThumbImageTag, ImageType.Thumb),
            (Field.ThumbImageItemId, Field.ThumbImageTag, ImageType.Thumb),
        };

        // Unescaped names by length, for the common case of a name without escapes.
        private static readonly Dictionary<int, (byte[] Name, Field Field)[]> ByLength = Fields
            .SelectMany(f => new[] { f.Pascal, f.Camel }.Distinct(StringComparer.Ordinal).Select(n => (Name: Encoding.UTF8.GetBytes(n), f.Field)))
            .GroupBy(n => n.Name.Length)
            .ToDictionary(g => g.Key, g => g.ToArray());

        private static readonly byte[][] HolderTypeNames = HolderKinds.Select(k => Encoding.UTF8.GetBytes(k.ToString())).ToArray();
        private static readonly byte[][] HolderCollectionTypes = { Encoding.UTF8.GetBytes(nameof(CollectionType.playlists)), Encoding.UTF8.GetBytes(nameof(CollectionType.boxsets)) };
        private static readonly ImageType[] OwnTypes = { ImageType.Primary, ImageType.Thumb };
        private static readonly byte[] Bom = { 0xEF, 0xBB, 0xBF };

        /// <summary>A recognized field.</summary>
        internal enum Field : byte
        {
            None = 0,
            Id,
            Type,
            CollectionType,
            ImageTags,
            ImageBlurHashes,
            PrimaryImageAspectRatio,
            PrimaryImageTag,
            HasPrimaryImage,
            HasThumbImage,
            ParentPrimaryImageItemId,
            ParentPrimaryImageTag,
            ParentThumbItemId,
            ParentThumbImageTag,
            ThumbImageItemId,
            ThumbImageTag,
            Primary,
            Thumb,
        }

        /// <summary>
        /// Projects one JSON payload held in memory (a WebSocket message).
        /// </summary>
        /// <param name="json">The payload's UTF-8 bytes.</param>
        /// <param name="view">This payload's view.</param>
        /// <param name="projected">The projected payload when <see cref="LegacyCollageProjected.Changed"/>.</param>
        /// <returns>What happened. Never throws for a payload; the view's own failures (the library) do propagate.</returns>
        public static LegacyCollageProjected Project(ReadOnlySpan<byte> json, LegacyCollageView view, out byte[]? projected)
        {
            projected = null;
            if (Decide(json, view) is not { } edits)
            {
                return LegacyCollageProjected.NotJson;
            }

            if (edits.Count == 0)
            {
                return LegacyCollageProjected.Unchanged;
            }

            var output = new ArrayBufferWriter<byte>(json.Length);
            var at = 0;
            foreach (var edit in edits)
            {
                output.Write(json[at..(int)edit.Start]);
                if (edit.False)
                {
                    output.Write("false"u8);
                }

                at = (int)edit.End;
            }

            output.Write(json[at..]);
            projected = output.WrittenSpan.ToArray();
            return LegacyCollageProjected.Changed;
        }

        /// <summary>The edits for one payload held in memory, in order; null when it isn't JSON.</summary>
        /// <param name="json">The payload's UTF-8 bytes.</param>
        /// <param name="view">This payload's view.</param>
        /// <returns>The edits (none: nothing withheld), or null.</returns>
        internal static IReadOnlyList<LegacyCollageEdit>? Decide(ReadOnlySpan<byte> json, LegacyCollageView view)
        {
            // A byte order mark is read past (a fetch() client does too) and kept.
            var bom = json.StartsWith(Bom) ? 3 : 0;
            var decider = new Decider(view);
            return decider.Feed(json[bom..], bom, isFinalBlock: true, out _) ? decider.Edits() : null;
        }

        /// <summary>
        /// The edits for one payload read from a stream (an answer body of any size), in order; null when it isn't JSON.
        /// The stream is read once, to its end, in blocks; only the open objects' recognized members are kept meanwhile.
        /// </summary>
        /// <param name="utf8">The payload's UTF-8 bytes, from its first byte.</param>
        /// <param name="view">This payload's view.</param>
        /// <returns>The edits (none: nothing withheld), or null.</returns>
        internal static IReadOnlyList<LegacyCollageEdit>? Decide(Stream utf8, LegacyCollageView view)
        {
            var decider = new Decider(view);
            var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
            try
            {
                long consumedTotal = 0;
                var filled = 0;
                var first = true;
                while (true)
                {
                    var read = utf8.Read(buffer, filled, buffer.Length - filled);
                    filled += read;
                    var final = read == 0;
                    var start = 0;
                    if (first)
                    {
                        if (filled < 3 && !final)
                        {
                            continue;
                        }

                        first = false;
                        if (buffer.AsSpan(0, filled).StartsWith(Bom))
                        {
                            start = 3;
                            consumedTotal = 3;
                        }
                    }

                    if (!decider.Feed(buffer.AsSpan(start, filled - start), consumedTotal, final, out var consumed))
                    {
                        return null;
                    }

                    if (final)
                    {
                        return decider.Edits();
                    }

                    consumedTotal += consumed;
                    var left = filled - start - consumed;
                    if (left > 0 && consumed + start == 0 && filled == buffer.Length)
                    {
                        // One token larger than the block: a bigger block (the token is held whole, nothing else is).
                        var bigger = ArrayPool<byte>.Shared.Rent(buffer.Length * 2);
                        buffer.AsSpan(0, filled).CopyTo(bigger);
                        ArrayPool<byte>.Shared.Return(buffer);
                        buffer = bigger;
                        continue;
                    }

                    buffer.AsSpan(start + consumed, left).CopyTo(buffer);
                    filled = left;
                }
            }
            catch (Exception ex) when (ex is IOException or DecoderFallbackException)
            {
                // The bytes couldn't be read as text in their character set: nothing could be checked.
                return null;
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(buffer);
            }
        }

        // ── decide: one pass of the reader; each object is decided when it closes ───────────

        // A container while it is open (and, for the maps an enclosing object may still edit, until that one closes): its
        // recognized members, the members next to them (for the separators), and what is taken out of it.
        private sealed class Node
        {
            public bool IsObject;
            public long Start;
            public long End;

            // The field this container is the value of, in its parent object (None in an array).
            public Field FieldInParent;

            // A blur-hash map of one image type, keyed by tag: any member can go (its name is the tag).
            public bool ByTag;
            public int Count;
            public long FirstStart;
            public long LastValueEnd;
            public List<Member> Members = new();
            public HashSet<int>? Removed;
            public HashSet<int>? Falsified;
            public Member Pending;
            public Member? Previous;

            // Ready to be used again (containers are pooled: checking an answer allocates little beyond its depth).
            public void Reset(bool isObject, long start, Field fieldInParent, bool byTag)
            {
                IsObject = isObject;
                Start = start;
                End = 0;
                FieldInParent = fieldInParent;
                ByTag = byTag;
                Count = 0;
                FirstStart = 0;
                LastValueEnd = 0;
                Members.Clear();
                Removed = null;
                Falsified = null;
                Pending = default;
                Previous = null;
            }

            public Member? At(int index)
            {
                foreach (var m in Members)
                {
                    if (m.Index == index)
                    {
                        return m;
                    }
                }

                return null;
            }
        }

        private struct Member
        {
            public int Index;
            public Field Field;
            public long NameStart;
            public long ValueStart;
            public long ValueEnd;
            public JsonTokenType Token;
            public Node? Child;
            public Guid? Guid;
            public bool Hint;
            public string? Text;
            public string? Name;
            public bool Kept;
        }

        private sealed class Decider
        {
            private readonly LegacyCollageView _view;
            private readonly List<Node> _stack = new();
            private readonly List<LegacyCollageEdit> _edits = new();
            private readonly Stack<Node> _free = new();
            private JsonReaderState _state = new(new JsonReaderOptions { MaxDepth = MaxDepth, CommentHandling = JsonCommentHandling.Disallow, AllowTrailingCommas = false });
            private bool _done;

            public Decider(LegacyCollageView view)
            {
                _view = view;
            }

            // Reads one block (positions offset by origin); false when the payload isn't JSON.
            public bool Feed(ReadOnlySpan<byte> block, long origin, bool isFinalBlock, out int consumed)
            {
                consumed = 0;
                try
                {
                    var reader = new Utf8JsonReader(block, isFinalBlock, _state);
                    while (reader.Read())
                    {
                        Token(ref reader, origin);
                    }

                    _state = reader.CurrentState;
                    consumed = (int)reader.BytesConsumed;
                    return !isFinalBlock || _done;
                }
                catch (Exception ex) when (ex is JsonException or InvalidOperationException or ArgumentException)
                {
                    return false;
                }
            }

            // The edits in order, each once; null when they can't be applied faithfully (never happens for JSON).
            public IReadOnlyList<LegacyCollageEdit>? Edits()
            {
                if (!_done)
                {
                    return null;
                }

                _edits.Sort((a, b) => a.Start.CompareTo(b.Start));
                var result = new List<LegacyCollageEdit>(_edits.Count);
                foreach (var edit in _edits)
                {
                    if (result.Count > 0 && edit.Start < result[^1].End)
                    {
                        // Inside a member that goes as a whole: nothing more to do there.
                        if (edit.End <= result[^1].End && !result[^1].False)
                        {
                            continue;
                        }

                        return null;
                    }

                    result.Add(edit);
                }

                return result;
            }

            private void Token(ref Utf8JsonReader reader, long origin)
            {
                var at = origin + reader.TokenStartIndex;
                var top = _stack.Count > 0 ? _stack[^1] : null;
                switch (reader.TokenType)
                {
                    case JsonTokenType.PropertyName:
                        top!.Pending = new Member
                        {
                            Index = top.Count,
                            Field = Match(ref reader),
                            NameStart = at,
                            Name = top.ByTag ? Text(ref reader, 4096) : null,
                        };
                        break;
                    case JsonTokenType.StartObject:
                    case JsonTokenType.StartArray:
                        var field = top is { IsObject: true } ? top.Pending.Field : Field.None;
                        var opened = _free.Count > 0 ? _free.Pop() : new Node();
                        opened.Reset(reader.TokenType == JsonTokenType.StartObject, at, field, top is { IsObject: true, FieldInParent: Field.ImageBlurHashes } && field is Field.Primary or Field.Thumb);
                        _stack.Add(opened);
                        break;
                    case JsonTokenType.EndObject:
                    case JsonTokenType.EndArray:
                        var node = top!;
                        _stack.RemoveAt(_stack.Count - 1);
                        node.End = at + 1;
                        if (node.IsObject)
                        {
                            DecideObject(node, _view);
                        }

                        // An enclosing object may still edit its maps (ImageTags, ImageBlurHashes and their per-type maps).
                        var held = node.IsObject && (node.FieldInParent is Field.ImageTags or Field.ImageBlurHashes || node.ByTag);
                        if (_stack.Count == 0)
                        {
                            Flush(node);
                            Release(node);
                            _done = true;
                            break;
                        }

                        var parent = _stack[^1];
                        if (parent.IsObject)
                        {
                            var member = parent.Pending;
                            member.ValueStart = node.Start;
                            member.ValueEnd = node.End;
                            member.Token = node.IsObject ? JsonTokenType.StartObject : JsonTokenType.StartArray;
                            member.Child = held ? node : null;
                            Close(parent, member);
                        }

                        if (!held)
                        {
                            Flush(node);
                            Release(node);
                        }

                        break;
                    default:
                        if (top == null)
                        {
                            // A lone value holds no object; the reader still checks the rest is nothing but white space.
                            _done = true;
                            break;
                        }

                        if (top.IsObject)
                        {
                            var value = top.Pending;
                            value.ValueStart = at;
                            value.ValueEnd = at + reader.ValueSpan.Length + (reader.TokenType == JsonTokenType.String ? 2 : 0);
                            value.Token = reader.TokenType;
                            if (reader.TokenType == JsonTokenType.String)
                            {
                                Read(ref reader, ref value);
                            }

                            Close(top, value);
                        }

                        break;
                }
            }

            // A member of an object is complete. Kept: every recognized one and every member of a per-tag map (they are what
            // can go), and the members right before and after one (their bytes bound the separators).
            private static void Close(Node node, Member member)
            {
                if (node.Count == 0)
                {
                    node.FirstStart = member.NameStart;
                }

                node.Count++;
                node.LastValueEnd = member.ValueEnd;
                member.Kept = node.ByTag || member.Field != Field.None || member.Child != null;
                if (member.Kept)
                {
                    if (node.Previous is { Kept: false } previous && (node.Members.Count == 0 || node.Members[^1].Index != previous.Index))
                    {
                        node.Members.Add(previous);
                    }

                    node.Members.Add(member);
                }
                else if (node.Previous is { Kept: true })
                {
                    node.Members.Add(member);
                }

                node.Previous = member;
            }

            // The edits of a container (and of the maps it kept for itself) once nothing can edit it any more.
            private void Flush(Node node)
            {
                foreach (var member in node.Members)
                {
                    if (member.Child is { } child && !IsRemoved(node, member.Index))
                    {
                        Flush(child);
                    }
                }

                if (node.Removed is { Count: > 0 } removed)
                {
                    var runs = removed.OrderBy(i => i).ToList();
                    for (var i = 0; i < runs.Count;)
                    {
                        var r = runs[i];
                        var s = r;
                        while (i + 1 < runs.Count && runs[i + 1] == s + 1)
                        {
                            s = runs[++i];
                        }

                        i++;
                        long start;
                        long end;
                        if (r == 0)
                        {
                            // Leading members go with the separator after them.
                            start = node.FirstStart;
                            end = s == node.Count - 1 ? node.LastValueEnd : Start(node, node.At(s + 1)!.Value);
                        }
                        else
                        {
                            // Others go with the separator before them.
                            start = node.At(r - 1)!.Value.ValueEnd;
                            end = node.At(s)!.Value.ValueEnd;
                        }

                        _edits.Add(new LegacyCollageEdit(start, end, False: false));
                    }
                }

                if (node.Falsified != null)
                {
                    foreach (var index in node.Falsified)
                    {
                        if (!IsRemoved(node, index) && node.At(index) is { } member)
                        {
                            _edits.Add(new LegacyCollageEdit(member.ValueStart, member.ValueEnd, False: true));
                        }
                    }
                }
            }

            private static long Start(Node node, Member member) => node.IsObject ? member.NameStart : member.ValueStart;

            // A flushed container (and the maps it kept) can be used again.
            private void Release(Node node)
            {
                foreach (var member in node.Members)
                {
                    if (member.Child is { } child)
                    {
                        Release(child);
                    }
                }

                node.Members.Clear();
                _free.Push(node);
            }
        }

        private static Field Match(ref Utf8JsonReader reader)
        {
            if (!reader.ValueIsEscaped)
            {
                if (ByLength.TryGetValue(reader.ValueSpan.Length, out var candidates))
                {
                    foreach (var (name, field) in candidates)
                    {
                        if (reader.ValueSpan.SequenceEqual(name))
                        {
                            return field;
                        }
                    }
                }

                return Field.None;
            }

            // Escaped: compared as the client reads it (unescaped), still exactly.
            try
            {
                foreach (var candidates in ByLength.Values)
                {
                    foreach (var (name, field) in candidates)
                    {
                        if (reader.ValueTextEquals(name))
                        {
                            return field;
                        }
                    }
                }
            }
            catch (InvalidOperationException)
            {
                // An escaped lone surrogate: a name, but none of these.
            }

            return Field.None;
        }

        // The values the rule reads: ids, tags, and the kind hints that say an object may be a library folder.
        private static void Read(ref Utf8JsonReader reader, ref Member member)
        {
            switch (member.Field)
            {
                case Field.Id or Field.ParentPrimaryImageItemId or Field.ParentThumbItemId or Field.ThumbImageItemId:
                    // Read from the bytes as written in the usual forms; any other (or an escaped one) as the client reads it.
                    if ((Utf8Id(reader.ValueIsEscaped ? default : reader.ValueSpan) ?? (Text(ref reader, 256) is { } id && System.Guid.TryParse(id, out var parsed) ? parsed : System.Guid.Empty)) is var guid
                        && guid != System.Guid.Empty)
                    {
                        member.Guid = guid;
                    }

                    break;
                case Field.ParentPrimaryImageTag or Field.ParentThumbImageTag or Field.ThumbImageTag:
                    member.Text = Text(ref reader, 4096);
                    break;
                case Field.Type:
                    member.Hint = Any(ref reader, HolderTypeNames);
                    break;
                case Field.CollectionType:
                    member.Hint = Any(ref reader, HolderCollectionTypes);
                    break;
            }
        }

        // A GUID in one of the forms Guid.TryParse takes (32 digits, with hyphens, braces or parentheses), the whole value.
        private static System.Guid? Utf8Id(ReadOnlySpan<byte> value)
        {
            foreach (var format in "NDBP")
            {
                if (System.Buffers.Text.Utf8Parser.TryParse(value, out System.Guid guid, out var consumed, format) && consumed == value.Length)
                {
                    return guid;
                }
            }

            return null;
        }

        private static string? Text(ref Utf8JsonReader reader, int maxBytes)
        {
            if (reader.ValueSpan.Length > maxBytes)
            {
                return null;
            }

            try
            {
                return reader.GetString();
            }
            catch (InvalidOperationException)
            {
                // An escaped lone surrogate: no id or tag a client could use.
                return null;
            }
        }

        // A kind hint only decides whether the library is asked about an id, so it is compared leniently (any case).
        private static bool Any(ref Utf8JsonReader reader, byte[][] names)
        {
            if (!reader.ValueIsEscaped)
            {
                foreach (var name in names)
                {
                    if (Ascii.EqualsIgnoreCase(reader.ValueSpan, name))
                    {
                        return true;
                    }
                }

                // Not ASCII-equal: only a non-ASCII spelling could still match without regard to case.
                if (Ascii.IsValid(reader.ValueSpan))
                {
                    return false;
                }
            }

            return Text(ref reader, 64) is { } text && AnyText(text, names);
        }

        private static bool AnyText(string text, byte[][] names)
        {
            foreach (var name in names)
            {
                if (string.Equals(Encoding.UTF8.GetString(name), text, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }

        // ── which recognized fields of an object go ─────────

        private static void DecideObject(Node node, LegacyCollageView view)
        {
            var members = node.Members;
            var hinted = false;
            var named = false;
            var referring = false;
            foreach (var m in members)
            {
                hinted |= m.Field is Field.Type or Field.CollectionType && m.Hint;
                named |= m.Field == Field.Id && m.Guid != null;
                referring |= m.Field is Field.ParentPrimaryImageItemId or Field.ParentThumbItemId or Field.ThumbImageItemId && m.Guid != null;
            }

            if (!named && !referring)
            {
                return;
            }

            foreach (var type in OwnTypes)
            {
                // The library is asked about an id that has a marker (or any id while the markers can't be listed), or one
                // the object says is a library folder or view a tile can be composed for.
                if (!named || !OwnWithheld(members, hinted, type, view))
                {
                    continue;
                }

                var typeKey = type == ImageType.Primary ? Field.Primary : Field.Thumb;
                foreach (var member in members)
                {
                    switch (member.Field)
                    {
                        case Field.ImageTags or Field.ImageBlurHashes when member.Child is { IsObject: true } map:
                            foreach (var entry in map.Members)
                            {
                                if (entry.Field == typeKey)
                                {
                                    Remove(map, entry.Index);
                                }
                            }

                            break;
                        case Field.PrimaryImageAspectRatio or Field.PrimaryImageTag when type == ImageType.Primary:
                            Remove(node, member.Index);
                            break;
                        case Field.HasPrimaryImage when type == ImageType.Primary && member.Token == JsonTokenType.True:
                        case Field.HasThumbImage when type == ImageType.Thumb && member.Token == JsonTokenType.True:
                            (node.Falsified ??= new HashSet<int>()).Add(member.Index);
                            break;
                    }
                }
            }

            foreach (var (idField, tagField, type) in referring ? References : Array.Empty<(Field, Field, ImageType)>())
            {
                if (!Refers(members, idField, type, view))
                {
                    continue;
                }

                var tags = members.Where(m => m.Field == tagField && m.Text != null).Select(m => m.Text!).ToHashSet(StringComparer.Ordinal);
                foreach (var member in members)
                {
                    if (member.Field == idField || member.Field == tagField)
                    {
                        Remove(node, member.Index);
                    }
                }

                var typeKey = type == ImageType.Primary ? Field.Primary : Field.Thumb;
                foreach (var hashes in members.Where(m => m.Field == Field.ImageBlurHashes && m.Child is { IsObject: true }).Select(m => m.Child!))
                {
                    foreach (var entry in hashes.Members)
                    {
                        if (entry.Field != typeKey || entry.Child is not { IsObject: true } byTag || IsRemoved(hashes, entry.Index))
                        {
                            continue;
                        }

                        var removed = false;
                        foreach (var hash in byTag.Members)
                        {
                            if (hash.Name is { } name && tags.Contains(name))
                            {
                                removed |= Remove(byTag, hash.Index);
                            }
                        }

                        if (removed && byTag.Removed!.Count == byTag.Count)
                        {
                            Remove(hashes, entry.Index);
                        }
                    }
                }
            }
        }

        private static bool OwnWithheld(List<Member> members, bool hinted, ImageType type, LegacyCollageView view)
        {
            foreach (var m in members)
            {
                if (m.Field == Field.Id && m.Guid is { } id && (hinted || view.ListCandidate(id)) && view.Image(id, type))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool Refers(List<Member> members, Field idField, ImageType type, LegacyCollageView view)
        {
            foreach (var m in members)
            {
                if (m.Field == idField && m.Guid is { } id && view.Image(id, type))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool IsRemoved(Node node, int index) => node.Removed?.Contains(index) ?? false;

        private static bool Remove(Node node, int index) => (node.Removed ??= new HashSet<int>()).Add(index);
    }
}
