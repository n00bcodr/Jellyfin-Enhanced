using System;
using System.Buffers;
using System.Collections.Generic;
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
        /// Projects one JSON payload (an answer body or a WebSocket message).
        /// </summary>
        /// <param name="json">The payload's UTF-8 bytes.</param>
        /// <param name="view">This payload's view.</param>
        /// <param name="projected">The projected payload when <see cref="LegacyCollageProjected.Changed"/>.</param>
        /// <returns>What happened. Never throws for a payload; the view's own failures (the library) do propagate.</returns>
        public static LegacyCollageProjected Project(ReadOnlySpan<byte> json, LegacyCollageView view, out byte[]? projected)
        {
            projected = null;
            // A byte order mark is read past (a fetch() client does too) and kept.
            var bom = json.StartsWith((ReadOnlySpan<byte>)new byte[] { 0xEF, 0xBB, 0xBF }) ? 3 : 0;
            var output = new ArrayBufferWriter<byte>(Math.Max(json.Length, 1));
            output.Write(json[..bom]);
            json = json[bom..];
            switch (Scan(json, view))
            {
                case null:
                    return LegacyCollageProjected.NotJson;
                case false:
                    // Names no marked list, no library folder or view, and no withheld image: nothing to take out.
                    return LegacyCollageProjected.Unchanged;
            }

            if (Parse(json) is not { } parsed)
            {
                return LegacyCollageProjected.NotJson;
            }

            if (parsed.Root == null || !Decide(json, parsed.Root, view))
            {
                return LegacyCollageProjected.Unchanged;
            }

            output.Write(json[..parsed.Root.Start]);
            Emit(json, parsed.Root, output);
            output.Write(json[parsed.Root.End..]);
            projected = output.WrittenSpan.ToArray();
            return LegacyCollageProjected.Changed;
        }

        // ── scan: one pass of the reader, no tree; whether any object could lose anything ─────

        // Null when it isn't JSON. True when an object names an id that has a marker (any id while the markers can't be
        // listed), says it is a library folder or view a tile can be composed for, or refers to a withheld image: the
        // conditions the decision below starts from, so a false here means the decision would take nothing out.
        private static bool? Scan(ReadOnlySpan<byte> json, LegacyCollageView view)
        {
            try
            {
                var reader = new Utf8JsonReader(json, new JsonReaderOptions { MaxDepth = MaxDepth, CommentHandling = JsonCommentHandling.Disallow, AllowTrailingCommas = false });
                if (!reader.Read())
                {
                    return null;
                }

                var hit = false;
                var field = Field.None;
                do
                {
                    if (reader.TokenType == JsonTokenType.PropertyName)
                    {
                        field = hit ? Field.None : Match(ref reader);
                        continue;
                    }

                    if (field != Field.None && reader.TokenType == JsonTokenType.String)
                    {
                        var member = new Member { Field = field };
                        Read(ref reader, ref member);
                        hit = member.Field switch
                        {
                            Field.Id => member.Guid is { } id && view.ListCandidate(id),
                            Field.Type or Field.CollectionType => member.Hint,
                            Field.ParentPrimaryImageItemId => member.Guid is { } id && view.Image(id, ImageType.Primary),
                            Field.ParentThumbItemId or Field.ThumbImageItemId => member.Guid is { } id && view.Image(id, ImageType.Thumb),
                            _ => false,
                        };
                    }

                    field = Field.None;
                }
                while (reader.Read());

                return hit;
            }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException or ArgumentException)
            {
                return null;
            }
        }

        // ── parse: one pass of the reader, keeping each container's and property's byte range ──

        private sealed class Parsed
        {
            public Node? Root { get; init; }
        }

        private sealed class Node
        {
            public bool IsObject;
            public int Start;
            public int End;
            public List<Member> Members = new();
            public HashSet<int>? Removed;
            public HashSet<int>? Falsified;
            public bool Edited;
        }

        private struct Member
        {
            public Field Field;
            public int NameStart;
            public int NameEnd;
            public int ValueStart;
            public int ValueEnd;
            public JsonTokenType Token;
            public Node? Child;
            public Guid? Guid;
            public bool Hint;
            public string? Text;
        }

        private static Parsed? Parse(ReadOnlySpan<byte> json)
        {
            try
            {
                var reader = new Utf8JsonReader(json, new JsonReaderOptions { MaxDepth = MaxDepth, CommentHandling = JsonCommentHandling.Disallow, AllowTrailingCommas = false });
                if (!reader.Read())
                {
                    return null;
                }

                if (reader.TokenType is not (JsonTokenType.StartObject or JsonTokenType.StartArray))
                {
                    // A lone value holds no object; the reader still checks the rest is nothing but white space.
                    while (reader.Read())
                    {
                    }

                    return new Parsed();
                }

                var stack = new Stack<(Node Node, Member Pending)>();
                var root = new Node { IsObject = reader.TokenType == JsonTokenType.StartObject, Start = (int)reader.TokenStartIndex };
                stack.Push((root, default));
                while (stack.Count > 0 && reader.Read())
                {
                    var (node, pending) = stack.Peek();
                    switch (reader.TokenType)
                    {
                        case JsonTokenType.PropertyName:
                            var start = (int)reader.TokenStartIndex;
                            stack.Pop();
                            stack.Push((node, new Member { Field = Match(ref reader), NameStart = start, NameEnd = start + reader.ValueSpan.Length + 2 }));
                            break;
                        case JsonTokenType.StartObject:
                        case JsonTokenType.StartArray:
                            stack.Push((new Node { IsObject = reader.TokenType == JsonTokenType.StartObject, Start = (int)reader.TokenStartIndex }, default));
                            break;
                        case JsonTokenType.EndObject:
                        case JsonTokenType.EndArray:
                            node.End = (int)reader.TokenStartIndex + 1;
                            stack.Pop();
                            if (stack.Count > 0)
                            {
                                var (parent, member) = stack.Peek();
                                member.ValueStart = node.Start;
                                member.ValueEnd = node.End;
                                member.Token = node.IsObject ? JsonTokenType.StartObject : JsonTokenType.StartArray;
                                member.Child = node;
                                parent.Members.Add(member);
                            }

                            break;
                        default:
                            var valueStart = (int)reader.TokenStartIndex;
                            var value = pending;
                            value.ValueStart = valueStart;
                            value.ValueEnd = valueStart + reader.ValueSpan.Length + (reader.TokenType == JsonTokenType.String ? 2 : 0);
                            value.Token = reader.TokenType;
                            if (reader.TokenType == JsonTokenType.String)
                            {
                                Read(ref reader, ref value);
                            }

                            node.Members.Add(value);
                            break;
                    }
                }

                // The reader checks nothing but white space follows the value.
                while (reader.Read())
                {
                }

                return new Parsed { Root = root };
            }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException or ArgumentException)
            {
                return null;
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
                    if (Text(ref reader, 256) is { } id && System.Guid.TryParse(id, out var guid) && guid != System.Guid.Empty)
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
            => Text(ref reader, 64) is { } text && names.Any(n => string.Equals(Encoding.UTF8.GetString(n), text, StringComparison.OrdinalIgnoreCase));

        // ── decide: which recognized fields of which objects go ─────────

        private static bool Decide(ReadOnlySpan<byte> json, Node node, LegacyCollageView view)
        {
            var edited = node.IsObject && DecideObject(json, node, view);
            for (var i = 0; i < node.Members.Count; i++)
            {
                if (node.Members[i].Child is { } child && !IsRemoved(node, i))
                {
                    edited |= Decide(json, child, view);
                }
            }

            // Removals made in this node while its parent was decided count too.
            node.Edited |= edited;
            return node.Edited;
        }

        private static readonly ImageType[] OwnTypes = { ImageType.Primary, ImageType.Thumb };

        private static bool DecideObject(ReadOnlySpan<byte> json, Node node, LegacyCollageView view)
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
                return false;
            }

            var changed = false;
            foreach (var type in OwnTypes)
            {
                // The library is asked about an id that has a marker (or any id while the markers can't be listed), or one
                // the object says is a library folder or view a tile can be composed for.
                if (!named || !OwnWithheld(members, hinted, type, view))
                {
                    continue;
                }

                var typeKey = type == ImageType.Primary ? Field.Primary : Field.Thumb;
                for (var i = 0; i < members.Count; i++)
                {
                    var member = members[i];
                    switch (member.Field)
                    {
                        case Field.ImageTags or Field.ImageBlurHashes when member.Child is { IsObject: true } map:
                            changed |= RemoveWhere(map, m => m.Field == typeKey);
                            break;
                        case Field.PrimaryImageAspectRatio or Field.PrimaryImageTag when type == ImageType.Primary:
                            changed |= Remove(node, i);
                            break;
                        case Field.HasPrimaryImage when type == ImageType.Primary && member.Token == JsonTokenType.True:
                        case Field.HasThumbImage when type == ImageType.Thumb && member.Token == JsonTokenType.True:
                            (node.Falsified ??= new HashSet<int>()).Add(i);
                            changed = true;
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
                for (var i = 0; i < members.Count; i++)
                {
                    if (members[i].Field == idField || members[i].Field == tagField)
                    {
                        changed |= Remove(node, i);
                    }
                }

                var typeKey = type == ImageType.Primary ? Field.Primary : Field.Thumb;
                foreach (var hashes in members.Where(m => m.Field == Field.ImageBlurHashes && m.Child is { IsObject: true }).Select(m => m.Child!))
                {
                    for (var i = 0; i < hashes.Members.Count; i++)
                    {
                        if (hashes.Members[i].Field != typeKey || hashes.Members[i].Child is not { IsObject: true } byTag || IsRemoved(hashes, i))
                        {
                            continue;
                        }

                        var removed = false;
                        for (var j = 0; j < byTag.Members.Count; j++)
                        {
                            if (NameText(json, byTag.Members[j]) is { } name && tags.Contains(name))
                            {
                                removed |= Remove(byTag, j);
                            }
                        }

                        if (removed)
                        {
                            changed = true;
                            hashes.Edited = true;
                            if (Enumerable.Range(0, byTag.Members.Count).All(j => IsRemoved(byTag, j)))
                            {
                                Remove(hashes, i);
                            }
                        }
                    }
                }
            }

            return changed;
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

        private static bool Remove(Node node, int index)
        {
            node.Removed ??= new HashSet<int>();
            if (!node.Removed.Add(index))
            {
                return false;
            }

            node.Edited = true;
            return true;
        }

        private delegate bool MemberTest(Member member);

        private static bool RemoveWhere(Node map, MemberTest test)
        {
            var any = false;
            for (var i = 0; i < map.Members.Count; i++)
            {
                if (test(map.Members[i]))
                {
                    any |= Remove(map, i);
                }
            }

            return any;
        }

        private static string? NameText(ReadOnlySpan<byte> json, Member member)
        {
            try
            {
                var reader = new Utf8JsonReader(json[member.NameStart..member.NameEnd]);
                return reader.Read() && reader.TokenType == JsonTokenType.String ? reader.GetString() : null;
            }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException)
            {
                return null;
            }
        }

        // ── emit: every byte as it was but the removed members (each with one separator) and the falsified flags ──

        private static int MemberStart(Node node, Member member) => node.IsObject ? member.NameStart : member.ValueStart;

        private static void Emit(ReadOnlySpan<byte> json, Node node, ArrayBufferWriter<byte> output)
        {
            if (!node.Edited || node.Members.Count == 0)
            {
                output.Write(json[node.Start..node.End]);
                return;
            }

            var members = node.Members;
            // The opening bracket and the white space after it.
            output.Write(json[node.Start..MemberStart(node, members[0])]);
            var previous = -1;
            for (var i = 0; i < members.Count; i++)
            {
                if (IsRemoved(node, i))
                {
                    continue;
                }

                var member = members[i];
                if (previous >= 0)
                {
                    // The separator as it stood before this member.
                    output.Write(json[members[i - 1].ValueEnd..MemberStart(node, member)]);
                }

                if (node.IsObject)
                {
                    // The name, and the colon with its white space.
                    output.Write(json[member.NameStart..member.ValueStart]);
                }

                if (node.Falsified?.Contains(i) == true)
                {
                    output.Write("false"u8);
                }
                else if (member.Child != null)
                {
                    Emit(json, member.Child, output);
                }
                else
                {
                    output.Write(json[member.ValueStart..member.ValueEnd]);
                }

                previous = i;
            }

            // The white space before the closing bracket, and the bracket.
            output.Write(json[members[^1].ValueEnd..node.End]);
        }
    }
}
