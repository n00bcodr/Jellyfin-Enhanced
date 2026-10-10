using System;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>The played item as list auto-requests see it.</summary>
    /// <param name="Id">Item id.</param>
    /// <param name="Kind">Jellyfin item kind.</param>
    /// <param name="Name">Display name (logs only).</param>
    /// <param name="SeriesId">Episode/season: the series.</param>
    /// <param name="SeasonId">Episode: the season.</param>
    public sealed record PlayedItem(Guid Id, BaseItemKind Kind, string Name, Guid? SeriesId, Guid? SeasonId)
    {
        /// <summary>Builds the record from a library item.</summary>
        /// <param name="item">The played item.</param>
        /// <returns>The record.</returns>
        public static PlayedItem From(BaseItem item)
        {
            Guid? series = null;
            Guid? season = null;
            switch (item)
            {
                case Episode episode:
                    series = episode.SeriesId == Guid.Empty ? null : episode.SeriesId;
                    season = episode.SeasonId == Guid.Empty ? null : episode.SeasonId;
                    break;
                case Season seasonItem:
                    series = seasonItem.SeriesId == Guid.Empty ? null : seasonItem.SeriesId;
                    break;
            }

            return new PlayedItem(item.Id, item.GetBaseItemKind(), item.Name ?? string.Empty, series, season);
        }
    }

    /// <summary>Library facts list auto-requests need beyond <see cref="IListPlaceholderHost"/> (seam for tests).</summary>
    public interface IAutoRequestLibrary
    {
        /// <summary>The premiere date of a library item (collections sort their real children by it).</summary>
        /// <param name="itemId">Item id.</param>
        /// <returns>The date, or null when unknown.</returns>
        DateTime? GetPremiereDate(Guid itemId);
    }

    /// <summary>The production <see cref="IAutoRequestLibrary"/> over Jellyfin's library manager.</summary>
    public sealed class JellyfinAutoRequestLibrary : IAutoRequestLibrary
    {
        private readonly ILibraryManager _libraryManager;

        /// <summary>Creates the seam.</summary>
        /// <param name="libraryManager">Library manager.</param>
        public JellyfinAutoRequestLibrary(ILibraryManager libraryManager) => _libraryManager = libraryManager;

        /// <inheritdoc />
        public DateTime? GetPremiereDate(Guid itemId) => _libraryManager.GetItemById(itemId)?.PremiereDate;
    }
}
