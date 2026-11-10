using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Resolution;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags
{
    /// <summary>
    /// What a tag look rule reads about an image owner, the facts core/tag-look.js factsFrom
    /// reads from a card's tag data: the item type, its library (a season's or episode's is its
    /// series'), its genres and its official rating (a season or episode falls back to its series').
    /// Native posters decide a rule from these exactly as the web decides it from the tag cache entry.
    /// </summary>
    /// <param name="Type">The image owner's item type.</param>
    /// <param name="LibraryId">Its library id (N format), or null.</param>
    /// <param name="Genres">Its genres.</param>
    /// <param name="OfficialRating">Its official rating, or null.</param>
    public sealed record PosterTagLookFacts(string? Type, string? LibraryId, IReadOnlyList<string> Genres, string? OfficialRating)
    {
        /// <summary>The facts in the server tag cache entry, the same data web cards match rules on.</summary>
        /// <param name="entry">The owner's cache entry.</param>
        /// <returns>The facts.</returns>
        public static PosterTagLookFacts FromEntry(TagCacheEntry entry)
            => new(entry.Type, entry.LibraryId, entry.Genres ?? Array.Empty<string>(), entry.OfficialRating);

        /// <summary>
        /// The facts from the library item itself, for an owner the tag cache has no entry for (the
        /// cache is off or not built yet): the same fields the web's batch lookup sends.
        /// </summary>
        /// <param name="libraryManager">Jellyfin's library manager.</param>
        /// <param name="item">The owner.</param>
        /// <returns>The facts.</returns>
        public static PosterTagLookFacts FromItem(ILibraryManager libraryManager, BaseItem item)
        {
            var seriesId = item switch
            {
                Episode episode => episode.SeriesId,
                Season season => season.SeriesId,
                _ => Guid.Empty,
            };
            var series = seriesId == Guid.Empty ? null : libraryManager.GetItemById(seriesId);
            var genres = item.Genres is { Length: > 0 } own ? own : series?.Genres ?? Array.Empty<string>();
            var rating = string.IsNullOrWhiteSpace(item.OfficialRating) ? series?.OfficialRating : item.OfficialRating;
            return new(item.GetBaseItemKind().ToString(), ItemLibraryResolver.Resolve(libraryManager, item, series), genres, rating);
        }

        /// <summary>Whether every condition of an enabled rule holds (core/tag-look.js matches).</summary>
        /// <param name="rule">A normalised rule.</param>
        /// <returns>True when the rule applies.</returns>
        public bool Matches(TagLookRule rule)
        {
            if (!rule.Enabled || rule.When.Count == 0) return false;
            foreach (var condition in rule.When)
            {
                var holds = condition.Field switch
                {
                    "library" => LibraryId is { Length: > 0 } && string.Equals(LibraryId, condition.Value, StringComparison.Ordinal),
                    "type" => Type is { Length: > 0 } && string.Equals(Type, condition.Value, StringComparison.OrdinalIgnoreCase),
                    "genre" => Genres.Any(genre => string.Equals(JsText.ToLower(JsText.Trim(genre ?? string.Empty)), JsText.ToLower(condition.Value), StringComparison.Ordinal)),
                    "ageRating" => Rating(OfficialRating) is { Length: > 0 } have && have == Rating(condition.Value),
                    _ => false,
                };
                if (!holds) return false;
            }

            return true;
        }

        /// <summary>The first enabled rule whose conditions all hold, or null (core/tag-look.js firstMatch).</summary>
        /// <param name="rules">Normalised rules in order.</param>
        /// <returns>The rule and its position, or null.</returns>
        public (TagLookRule Rule, int Index)? FirstMatch(IReadOnlyList<TagLookRule>? rules)
        {
            if (rules is null) return null;
            for (var i = 0; i < rules.Count; i++)
            {
                if (Matches(rules[i])) return (rules[i], i);
            }

            return null;
        }

        // core/tag-look.js normalizeRating: the age rating tags' normalised text, lowercased.
        private static string Rating(string? raw)
        {
            if (raw is null) return string.Empty;
            var normalized = AgeRatingRules.Normalize(raw);
            return normalized is null ? string.Empty : JsText.ToLower(normalized);
        }
    }
}
