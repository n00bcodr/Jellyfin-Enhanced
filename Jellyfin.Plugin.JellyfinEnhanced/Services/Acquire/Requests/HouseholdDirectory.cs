using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using MediaBrowser.Controller.Library;
using Jellyfin.Data.Enums;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>One Jellyfin account as the household views see it (server side only; never sent whole).</summary>
    public sealed record HouseholdPerson
    {
        /// <summary>Jellyfin user id.</summary>
        public Guid Id { get; init; }

        /// <summary>Jellyfin user name (the household's display name).</summary>
        public string Name { get; init; } = string.Empty;

        /// <summary>Jellyfin administrator.</summary>
        public bool IsAdmin { get; init; }

        /// <summary>The account is disabled.</summary>
        public bool Disabled { get; init; }

        /// <summary>Libraries the person may open; null means every library.</summary>
        public IReadOnlyCollection<Guid>? Libraries { get; init; }

        /// <summary>Libraries blocked for the person (they never count as shared).</summary>
        public IReadOnlyCollection<Guid> Blocked { get; init; } = Array.Empty<Guid>();

        /// <summary>The person has a parental rating limit or tag rules.</summary>
        public bool HasParentalLimit { get; init; }

        /// <summary>
        /// True when this person and <paramref name="other"/> can both open at least one library
        /// (<paramref name="all"/> lists every library, for people allowed all of them).
        /// </summary>
        public bool SharesLibraryWith(HouseholdPerson other, IReadOnlyCollection<Guid> all)
        {
            var mine = (Libraries ?? all).Where(l => !Blocked.Contains(l));
            var theirs = (other.Libraries ?? all).Where(l => !other.Blocked.Contains(l)).ToHashSet();
            return mine.Any(theirs.Contains);
        }
    }

    /// <summary>A Jellyfin movie or series item's display facts.</summary>
    public sealed record HouseholdItem(string Name, int? Year, string? OfficialRating);

    /// <summary>
    /// The Jellyfin side of the household views: the people on the server (with their library
    /// access, for the Manager's "shares a library" rule), library ids, and an item's display facts.
    /// </summary>
    public interface IHouseholdDirectory
    {
        /// <summary>Every Jellyfin account.</summary>
        IReadOnlyList<HouseholdPerson> People();

        /// <summary>One account, or null when Jellyfin doesn't know it.</summary>
        HouseholdPerson? Person(Guid userId);

        /// <summary>Every library (collection folder) id.</summary>
        IReadOnlyCollection<Guid> Libraries();

        /// <summary>Display facts of an item (name, year, official rating), or null.</summary>
        HouseholdItem? Item(Guid itemId);
    }

    /// <summary>The household directory over Jellyfin's user and library managers.</summary>
    public sealed class JellyfinHouseholdDirectory : IHouseholdDirectory
    {
        private readonly IUserManager _users;
        private readonly ILibraryManager _library;

        /// <summary>Creates the directory (DI).</summary>
        public JellyfinHouseholdDirectory(IUserManager users, ILibraryManager library)
        {
            _users = users;
            _library = library;
        }

        /// <inheritdoc />
        public IReadOnlyList<HouseholdPerson> People() => _users.GetAllUsers().Select(Map).ToList();

        /// <inheritdoc />
        public HouseholdPerson? Person(Guid userId) => Helpers.ArrCaller.Find(userId, _users) is { } user ? Map(user) : null;

        /// <inheritdoc />
        public IReadOnlyCollection<Guid> Libraries()
            => JellyfinLibraryAccess.ReadLibraries(_library).Select(l => Guid.TryParse(l.Id, out var id) ? id : Guid.Empty).Where(id => id != Guid.Empty).ToList();

        /// <inheritdoc />
        public HouseholdItem? Item(Guid itemId)
        {
            var item = itemId == Guid.Empty ? null : _library.GetItemById(itemId);
            return item == null ? null : new HouseholdItem(item.Name ?? string.Empty, item.ProductionYear, string.IsNullOrWhiteSpace(item.OfficialRating) ? null : item.OfficialRating);
        }

        private static HouseholdPerson Map(User user) => new()
        {
            Id = user.Id,
            Name = user.Username ?? string.Empty,
            IsAdmin = user.HasPermission(PermissionKind.IsAdministrator),
            Disabled = user.HasPermission(PermissionKind.IsDisabled),
            Libraries = user.HasPermission(PermissionKind.EnableAllFolders) ? null : user.GetPreferenceValues<Guid>(PreferenceKind.EnabledFolders),
            Blocked = user.GetPreferenceValues<Guid>(PreferenceKind.BlockedMediaFolders),
            HasParentalLimit = user.MaxParentalRatingScore.HasValue
                || (user.GetPreference(PreferenceKind.BlockedTags)?.Length ?? 0) > 0
                || (user.GetPreference(PreferenceKind.AllowedTags)?.Length ?? 0) > 0
                || user.GetPreferenceValues<UnratedItem>(PreferenceKind.BlockUnratedItems).Length > 0,
        };
    }
}
