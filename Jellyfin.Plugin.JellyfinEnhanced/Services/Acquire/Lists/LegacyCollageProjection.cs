using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Authentication;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.LiveTv;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Search;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// The one projection that takes withheld legacy collages (and the library tiles built from them) out of whatever a
    /// client is sent, on every delivery path: MVC answers (<see cref="LegacyCollageWithholdFilter"/>), WebSocket messages
    /// (<see cref="LegacyCollageSockets"/>) and JE's own answers. The rule is the same in both forms:
    /// <list type="bullet">
    /// <item>An object naming an item (<c>Id</c>) that is a list (<c>Type</c> Playlist/BoxSet) or a library folder/view
    /// that a tile can be composed for (<see cref="HolderKinds"/>, or a playlists/boxsets <c>CollectionType</c>) loses its
    /// own withheld images: <c>ImageTags</c> and <c>ImageBlurHashes</c> of that type; for Primary also
    /// <c>PrimaryImageAspectRatio</c>, <c>PrimaryImageTag</c>, and <c>HasPrimaryImage</c> becomes false; for Thumb
    /// <c>HasThumbImage</c> becomes false.</item>
    /// <item>A reference to another item's withheld image loses the reference, its tag and its blur hash:
    /// <c>ParentPrimaryImageItemId</c>/<c>ParentPrimaryImageTag</c>, <c>ParentThumbItemId</c>/<c>ParentThumbImageTag</c>,
    /// a search hint's <c>ThumbImageItemId</c>/<c>ThumbImageTag</c>.</item>
    /// </list>
    /// The typed form edits the host's own answer objects in place (so the answer keeps its serializer and JSON profile);
    /// the wire form edits JSON. Every other image reference names an image type no collage was drawn into or an item
    /// that is never a list or a library tile.
    /// </summary>
    internal static class LegacyCollageProjection
    {
        /// <summary>Item kinds besides lists whose own tile the host composes from list images (when their collection type is
        /// playlists or boxsets).</summary>
        internal static readonly HashSet<BaseItemKind> HolderKinds = new() { BaseItemKind.CollectionFolder, BaseItemKind.UserView, BaseItemKind.ManualPlaylistsFolder };

        private static readonly JsonNodeOptions NodeOptions = new() { PropertyNameCaseInsensitive = true };

        private static readonly ImageType[] Withholdable = { ImageType.Primary, ImageType.Thumb };

        // ── typed ───────────────────────────────────────────────────────────

        /// <summary>
        /// Rewrites a host answer value in place when it is one of the shapes the host's controllers return that can carry
        /// item DTOs or search hints.
        /// </summary>
        /// <param name="value">The answer's value.</param>
        /// <param name="view">This answer's view.</param>
        /// <param name="replacement">A replacement when a lazy sequence had to be materialized for its edits to be the ones sent.</param>
        /// <returns>False when the value is no such shape (then <see cref="ProjectAnswer"/> applies).</returns>
        public static bool Rewrite(object value, LegacyCollageView view, out object? replacement)
        {
            replacement = null;
            switch (value)
            {
                case BaseItemDto dto:
                    Strip(dto, view);
                    return true;
                case QueryResult<BaseItemDto> query:
                    foreach (var dto in query.Items ?? Array.Empty<BaseItemDto>())
                    {
                        Strip(dto, view);
                    }

                    return true;
                case IEnumerable<BaseItemDto> sequence:
                    var list = sequence as IList<BaseItemDto> ?? sequence.ToList();
                    foreach (var dto in list)
                    {
                        Strip(dto, view);
                    }

                    replacement = ReferenceEquals(list, sequence) ? null : list;
                    return true;
                case SearchHintResult hints:
                    foreach (var hint in hints.SearchHints ?? Array.Empty<SearchHint>())
                    {
                        Strip(hint, view);
                    }

                    return true;
                case IEnumerable<RecommendationDto> recommendations:
                    var materialized = recommendations as IList<RecommendationDto> ?? recommendations.ToList();
                    foreach (var dto in materialized.SelectMany(r => r.Items ?? Array.Empty<BaseItemDto>()))
                    {
                        Strip(dto, view);
                    }

                    replacement = ReferenceEquals(materialized, recommendations) ? null : materialized;
                    return true;
                case AllThemeMediaResult theme:
                    foreach (var dto in new[] { theme.ThemeVideosResult, theme.ThemeSongsResult, theme.SoundtrackSongsResult }.SelectMany(r => r?.Items ?? Array.Empty<BaseItemDto>()))
                    {
                        Strip(dto, view);
                    }

                    return true;
                case SessionInfoDto session:
                    StripSession(session, view);
                    return true;
                case IEnumerable<SessionInfoDto> sessions:
                    var sessionList = sessions as IList<SessionInfoDto> ?? sessions.ToList();
                    foreach (var session in sessionList)
                    {
                        StripSession(session, view);
                    }

                    replacement = ReferenceEquals(sessionList, sessions) ? null : sessionList;
                    return true;
                case AuthenticationResult authentication:
                    StripSession(authentication.SessionInfo, view);
                    return true;
                case TimerInfoDto timer:
                    Strip(timer.ProgramInfo, view);
                    return true;
                case QueryResult<TimerInfoDto> timers:
                    foreach (var timer in timers.Items ?? Array.Empty<TimerInfoDto>())
                    {
                        Strip(timer?.ProgramInfo, view);
                    }

                    return true;
                default:
                    return false;
            }
        }

        /// <summary>Takes withheld images out of one item DTO (and its channel's current programme).</summary>
        /// <param name="dto">The DTO.</param>
        /// <param name="view">This answer's view.</param>
        /// <param name="nested">Whether this is the programme already.</param>
        public static void Strip(BaseItemDto? dto, LegacyCollageView view, bool nested = false)
        {
            if (dto == null)
            {
                return;
            }

            if (!nested)
            {
                Strip(dto.CurrentProgram, view, nested: true);
            }

            foreach (var type in Withholdable)
            {
                if (OwnWithheld(dto.Id, dto.Type, dto.CollectionType, type, view))
                {
                    dto.ImageTags?.Remove(type);
                    // The whole type: other JE filters may have re-keyed the hash under a stamped tag.
                    dto.ImageBlurHashes?.Remove(type);
                    if (type == ImageType.Primary)
                    {
                        dto.PrimaryImageAspectRatio = null;
                    }
                }
            }

            if (dto.ParentPrimaryImageItemId is { } parent && view.Image(parent, ImageType.Primary))
            {
                var tag = dto.ParentPrimaryImageTag;
                dto.ParentPrimaryImageItemId = null;
                dto.ParentPrimaryImageTag = null;
                RemoveHash(dto.ImageBlurHashes, ImageType.Primary, tag);
            }

            if (dto.ParentThumbItemId is { } thumbParent && view.Image(thumbParent, ImageType.Thumb))
            {
                var tag = dto.ParentThumbImageTag;
                dto.ParentThumbItemId = null;
                dto.ParentThumbImageTag = null;
                RemoveHash(dto.ImageBlurHashes, ImageType.Thumb, tag);
            }
        }

        /// <summary>Takes withheld images out of every item DTO a session carries.</summary>
        /// <param name="session">The session.</param>
        /// <param name="view">This answer's view.</param>
        public static void StripSession(SessionInfoDto? session, LegacyCollageView view)
        {
            if (session != null)
            {
                Strip(session.NowPlayingItem, view);
                Strip(session.NowViewingItem, view);
#if !JF12
                // 10.11 also sends the whole play queue's items (Jellyfin 12 sends ids only).
                foreach (var queued in session.NowPlayingQueueFullItems ?? Array.Empty<BaseItemDto>())
                {
                    Strip(queued, view);
                }
#endif
            }
        }

        private static void Strip(SearchHint hint, LegacyCollageView view)
        {
            if (OwnWithheld(hint.Id, hint.Type, null, ImageType.Primary, view))
            {
                hint.PrimaryImageTag = null;
                hint.PrimaryImageAspectRatio = null;
            }

            if (Guid.TryParse(hint.ThumbImageItemId, out var thumbItem) && view.Image(thumbItem, ImageType.Thumb))
            {
                hint.ThumbImageTag = null;
                hint.ThumbImageItemId = null;
            }
        }

        // Whether an object naming this item withholds its own image of that type.
        private static bool OwnWithheld(Guid id, BaseItemKind? type, CollectionType? collectionType, ImageType image, LegacyCollageView view)
        {
            if (id == Guid.Empty)
            {
                return false;
            }

            if (type is BaseItemKind.Playlist or BaseItemKind.BoxSet)
            {
                return image == ImageType.Primary && view.List(id);
            }

            return ((type is { } kind && HolderKinds.Contains(kind)) || LegacyCollageWithhold.HolderKind(collectionType) != null) && view.Image(id, image);
        }

        private static void RemoveHash(Dictionary<ImageType, Dictionary<string, string>>? hashes, ImageType type, string? tag)
        {
            if (tag != null && hashes != null && hashes.TryGetValue(type, out var byTag))
            {
                byTag.Remove(tag);
                if (byTag.Count == 0)
                {
                    hashes.Remove(type);
                }
            }
        }

        // ── wire ────────────────────────────────────────────────────────────

        /// <summary>
        /// The JSON form of an answer of any other shape (JE's own answers, anything the host adds), projected; null when
        /// nothing in it was withheld (then the answer is sent as it was).
        /// </summary>
        /// <param name="value">The answer's value.</param>
        /// <param name="options">The serializer options the answer would be written with.</param>
        /// <param name="view">This answer's view.</param>
        /// <returns>The projected JSON, or null.</returns>
        public static JsonNode? ProjectAnswer(object value, JsonSerializerOptions options, LegacyCollageView view)
        {
            var node = JsonNode.Parse(JsonSerializer.SerializeToUtf8Bytes(value, value.GetType(), options), NodeOptions);
            return Project(node, view) ? node : null;
        }

        /// <summary>A WebSocket message (UTF-8 JSON), projected; null when nothing in it was withheld.</summary>
        /// <param name="json">The message.</param>
        /// <param name="view">This message's view.</param>
        /// <returns>The projected message, or null. Throws when it isn't JSON.</returns>
        public static byte[]? ProjectMessage(ReadOnlySpan<byte> json, LegacyCollageView view)
        {
            var reader = new Utf8JsonReader(json, new JsonReaderOptions { CommentHandling = JsonCommentHandling.Disallow, MaxDepth = 256 });
            var node = JsonNode.Parse(ref reader, NodeOptions);
            return Project(node, view) ? JsonSerializer.SerializeToUtf8Bytes(node) : null;
        }

        /// <summary>Applies the rule to every object in the tree.</summary>
        /// <param name="node">The tree.</param>
        /// <param name="view">The view.</param>
        /// <returns>Whether anything was taken out.</returns>
        internal static bool Project(JsonNode? node, LegacyCollageView view)
        {
            switch (node)
            {
                case JsonObject item:
                    var changed = ProjectObject(item, view);
                    foreach (var child in item.Select(p => p.Value).ToList())
                    {
                        changed |= Project(child, view);
                    }

                    return changed;
                case JsonArray array:
                    var any = false;
                    foreach (var child in array.ToList())
                    {
                        any |= Project(child, view);
                    }

                    return any;
                default:
                    return false;
            }
        }

        private static bool ProjectObject(JsonObject item, LegacyCollageView view)
        {
            var changed = false;
            if (GuidOf(item["Id"]) is { } id)
            {
                var type = EnumOf<BaseItemKind>(item["Type"]);
                var collectionType = EnumOf<CollectionType>(item["CollectionType"]);
                foreach (var image in Withholdable)
                {
                    if (OwnWithheld(id, type, collectionType, image, view))
                    {
                        changed |= RemoveKey(item["ImageTags"] as JsonObject, image.ToString());
                        changed |= RemoveKey(item["ImageBlurHashes"] as JsonObject, image.ToString());
                        if (image == ImageType.Primary)
                        {
                            changed |= RemoveKey(item, "PrimaryImageAspectRatio");
                            changed |= RemoveKey(item, "PrimaryImageTag");
                            changed |= Falsify(item, "HasPrimaryImage");
                        }
                        else
                        {
                            changed |= Falsify(item, "HasThumbImage");
                        }
                    }
                }
            }

            changed |= Reference(item, "ParentPrimaryImageItemId", "ParentPrimaryImageTag", ImageType.Primary, view);
            changed |= Reference(item, "ParentThumbItemId", "ParentThumbImageTag", ImageType.Thumb, view);
            changed |= Reference(item, "ThumbImageItemId", "ThumbImageTag", ImageType.Thumb, view);
            return changed;
        }

        private static bool Reference(JsonObject item, string idName, string tagName, ImageType type, LegacyCollageView view)
        {
            if (GuidOf(item[idName]) is not { } id || !view.Image(id, type))
            {
                return false;
            }

            var tag = (item[tagName] as JsonValue)?.TryGetValue<string>(out var t) == true ? t : null;
            RemoveKey(item, idName);
            RemoveKey(item, tagName);
            if (tag != null && item["ImageBlurHashes"] is JsonObject hashes && hashes[type.ToString()] is JsonObject byTag)
            {
                RemoveKey(byTag, tag);
                if (byTag.Count == 0)
                {
                    RemoveKey(hashes, type.ToString());
                }
            }

            return true;
        }

        private static bool RemoveKey(JsonObject? item, string name)
        {
            if (item == null || !item.ContainsKey(name))
            {
                return false;
            }

            // The name as the object spells it (lookups are case-insensitive).
            var actual = item.First(p => string.Equals(p.Key, name, StringComparison.OrdinalIgnoreCase)).Key;
            return item.Remove(actual);
        }

        private static bool Falsify(JsonObject item, string name)
        {
            if (item[name] is JsonValue value && value.TryGetValue<bool>(out var current) && current)
            {
                var actual = item.First(p => string.Equals(p.Key, name, StringComparison.OrdinalIgnoreCase)).Key;
                item[actual] = false;
                return true;
            }

            return false;
        }

        private static Guid? GuidOf(JsonNode? node)
            => node is JsonValue value && value.TryGetValue<string>(out var text) && Guid.TryParse(text, out var id) && id != Guid.Empty ? id : null;

        private static T? EnumOf<T>(JsonNode? node)
            where T : struct, Enum
            => node is JsonValue value && value.TryGetValue<string>(out var text) && Enum.TryParse<T>(text, true, out var parsed) && !int.TryParse(text, out _) ? parsed : null;
    }
}
