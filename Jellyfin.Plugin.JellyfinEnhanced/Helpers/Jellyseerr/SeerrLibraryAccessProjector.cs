using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr
{
    /// <summary>How one Jellyfin item Seerr names looks to the caller.</summary>
    public enum SeerrLibraryCopy
    {
        /// <summary>No such item in the library (a stale Seerr id): nothing to hide.</summary>
        Missing,

        /// <summary>The caller can open it.</summary>
        Visible,

        /// <summary>The library has it, but not for the caller (a library they can't open, a parental limit, a blocked tag).</summary>
        Hidden,
    }

    /// <summary>
    /// Keeps Seerr's library links to what the caller may open. Seerr names the Jellyfin item of a title
    /// (<c>jellyfinMediaId</c> / <c>jellyfinMediaId4k</c>, with <c>mediaUrl</c> / <c>mediaUrl4k</c> built from them) on
    /// every media object it sends, whichever library holds it and whoever asks. Before a proxied answer
    /// reaches the caller each named item is checked against Jellyfin for them:
    /// <list type="bullet">
    /// <item>a copy they can open stays;</item>
    /// <item>a copy hidden from them is removed (id and link); when it was the standard copy, a copy they can
    /// open takes its place (the 4K copy, or another copy the library finds by TMDB id);</item>
    /// <item>a title row of a list (<c>results</c>, <c>parts</c>, <c>cast</c>, <c>crew</c>) whose every named copy
    /// is hidden from them and that has no copy they can open is left out, as the native details feeds do: a
    /// title the library holds but hides from the viewer is not shown at all (neither as in the library nor as
    /// something to request). Other media objects (a title's own details, requests, issues) keep their row
    /// without the hidden links.</item>
    /// </list>
    /// A body that names no Jellyfin item is returned unchanged without parsing. One that can't be read fails
    /// closed.
    /// </summary>
    public static class SeerrLibraryAccessProjector
    {
        private static readonly (string Id, string Url)[] Variants = { ("jellyfinMediaId", "mediaUrl"), ("jellyfinMediaId4k", "mediaUrl4k") };

        // The root lists whose rows are titles (search, discover, similar, recommendations, watchlist,
        // collection parts, a person's credits).
        private static readonly HashSet<string> TitleLists = new(StringComparer.Ordinal) { "results", "parts", "cast", "crew" };

        private enum Media { None, Shown, Hidden }

        /// <summary>
        /// Projects <paramref name="body"/> for one caller.
        /// </summary>
        /// <param name="body">Seerr's JSON body.</param>
        /// <param name="copy">How a named Jellyfin item looks to the caller.</param>
        /// <param name="visibleCopy">A copy of the title (<c>movie</c> or <c>tv</c>, TMDB id) the caller can open, or null.</param>
        /// <param name="projected">The body to send.</param>
        /// <returns>False when the body isn't JSON (the caller must not pass it on).</returns>
        public static bool TryProject(string body, Func<Guid, SeerrLibraryCopy> copy, Func<string, int, Guid?> visibleCopy, out string projected)
        {
            projected = body;
            if (string.IsNullOrEmpty(body)) return true;
            // An escaped property name (jellyfinMediaId) is the same property to a JSON reader.
            if (body.IndexOf("ellyfinMediaId", StringComparison.OrdinalIgnoreCase) < 0 && body.IndexOf("\\u", StringComparison.Ordinal) < 0) return true;
            try
            {
                var root = JsonNode.Parse(body);
                if (root == null) return false;
                var state = new State(copy, visibleCopy);
                Walk(root, false, state);
                if (state.Changed) projected = root.ToJsonString();
                return true;
            }
            catch (JsonException)
            {
                return false;
            }
            catch (InvalidOperationException)
            {
                return false;
            }
        }

        private sealed class State
        {
            public State(Func<Guid, SeerrLibraryCopy> copy, Func<string, int, Guid?> visibleCopy)
            {
                Copy = copy;
                VisibleCopy = visibleCopy;
            }

            public Func<Guid, SeerrLibraryCopy> Copy { get; }

            public Func<string, int, Guid?> VisibleCopy { get; }

            public Dictionary<JsonObject, Media> Done { get; } = new(ReferenceEqualityComparer.Instance);

            public bool Changed { get; set; }
        }

        private static void Walk(JsonNode node, bool titleList, State state)
        {
            if (node is JsonArray array)
            {
                for (var i = array.Count - 1; i >= 0; i--)
                {
                    if (array[i] is not { } item) continue;
                    if (titleList && item is JsonObject row && row["mediaInfo"] is JsonObject info && Project(info, row, state) == Media.Hidden)
                    {
                        array.RemoveAt(i);
                        state.Changed = true;
                        continue;
                    }

                    Walk(item, false, state);
                }

                return;
            }

            if (node is not JsonObject obj) return;
            if (Variants.Any(v => obj.ContainsKey(v.Id))) Project(obj, null, state);
            var isRoot = node.Parent == null;
            foreach (var (name, child) in obj.ToList())
            {
                if (child != null) Walk(child, isRoot && TitleLists.Contains(name), state);
            }
        }

        // One media object: hidden links removed, a copy the caller can open in the standard slot when it
        // doesn't hold one. Hidden when it named copies, all hidden, and none could replace them.
        private static Media Project(JsonObject media, JsonObject? row, State state)
        {
            if (state.Done.TryGetValue(media, out var done)) return done;
            var hidden = new bool[Variants.Length];
            var visible = new Guid?[Variants.Length];
            for (var i = 0; i < Variants.Length; i++)
            {
                if (media[Variants[i].Id] is not JsonValue value || value.GetValueKind() != JsonValueKind.String
                    || !Guid.TryParse(value.GetValue<string>(), out var id) || id == Guid.Empty)
                {
                    continue;
                }

                switch (state.Copy(id))
                {
                    case SeerrLibraryCopy.Visible:
                        visible[i] = id;
                        break;
                    case SeerrLibraryCopy.Hidden:
                        hidden[i] = true;
                        media.Remove(Variants[i].Id);
                        media.Remove(Variants[i].Url);
                        state.Changed = true;
                        break;
                }
            }

            Media result;
            if (!hidden.Any(h => h))
            {
                result = visible.Any(v => v != null) ? Media.Shown : Media.None;
            }
            else if (visible[0] != null)
            {
                result = Media.Shown;
            }
            else
            {
                // The standard slot is what lists link and filter by: it names the copy the caller can open.
                var replacement = visible[1] ?? Alternate(media, row, state);
                if (replacement is { } other)
                {
                    media[Variants[0].Id] = other.ToString("N", CultureInfo.InvariantCulture);
                    media.Remove(Variants[0].Url);
                }

                result = replacement != null ? Media.Shown : Media.Hidden;
            }

            state.Done[media] = result;
            return result;
        }

        // A copy of the same title the caller can open, found by its TMDB id (the media object's, else its row's).
        private static Guid? Alternate(JsonObject media, JsonObject? row, State state)
        {
            var type = Text(media, "mediaType") ?? (row != null ? Text(row, "mediaType") : null);
            var tmdb = Number(media, "tmdbId") ?? (row != null ? Number(row, "id") : null);
            if (type is not ("movie" or "tv") || tmdb is not > 0) return null;
            return state.VisibleCopy(type, tmdb.Value) is { } id && id != Guid.Empty ? id : null;
        }

        private static string? Text(JsonObject obj, string name)
            => obj[name] is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : null;

        private static int? Number(JsonObject obj, string name)
        {
            if (obj[name] is not JsonValue v) return null;
            if (v.GetValueKind() == JsonValueKind.Number && v.TryGetValue<int>(out var n)) return n;
            if (v.GetValueKind() == JsonValueKind.Number && v.TryGetValue<long>(out var l) && l is > 0 and <= int.MaxValue) return (int)l;
            return v.GetValueKind() == JsonValueKind.String && int.TryParse(v.GetValue<string>(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var s) ? s : null;
        }
    }
}
