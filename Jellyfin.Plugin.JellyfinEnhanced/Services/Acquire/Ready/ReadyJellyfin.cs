using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Events.Users;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready
{
    /// <summary>
    /// The production <see cref="IReadyLibrary"/>: Jellyfin's own user-scoped lookup of the exact version item (library
    /// access and parental limits of the person), a real file on disk, a kind a playlist can hold, and Jellyfin's Played.
    /// A generic Video (10.11's alternate movie version) is a legitimate version; its link to the logical title is checked
    /// by the selector through the logical item's own sources.
    /// </summary>
    public sealed class JellyfinReadyLibrary : IReadyLibrary
    {
        private readonly ILibraryManager _library;
        private readonly IUserManager _users;
        private readonly IUserDataManager _userData;

        /// <summary>Creates the checks (DI).</summary>
        public JellyfinReadyLibrary(ILibraryManager library, IUserManager users, IUserDataManager userData)
        {
            _library = library;
            _users = users;
            _userData = userData;
        }

        /// <inheritdoc />
        public ReadyVersionCheck Check(Guid userId, Guid playableItemId)
        {
            var user = userId == Guid.Empty ? null : _users.GetUserById(userId);
            if (user == null) return ReadyVersionCheck.NoAccess;
            if (_library.GetItemById<BaseItem>(playableItemId, user) is not Video video) return ReadyVersionCheck.NoAccess;
            if (video.IsVirtualItem || video.IsPlaceHolder || string.IsNullOrEmpty(video.Path) || !(File.Exists(video.Path) || Directory.Exists(video.Path))) return ReadyVersionCheck.NotPhysical;
            if (video.ExtraType != null || !video.SupportsAddingToPlaylist) return ReadyVersionCheck.NotInsertable;
            return ReadyVersionCheck.Ok;
        }

        /// <inheritdoc />
        public bool Played(Guid userId, Guid itemId)
        {
            var user = userId == Guid.Empty ? null : _users.GetUserById(userId);
            if (user == null || _library.GetItemById(itemId) is not { } item) return false;
            return _userData.GetUserData(user, item)?.Played == true;
        }
    }

    /// <summary>
    /// The production <see cref="IReadyPrivacy"/>: the person's Hidden Content (<c>hidden-content.json</c>, read strictly under
    /// its file lock) as rules for the library surface: a rule whose scope is global or library, while Hidden Content is on
    /// (server and person) and its library filter is on. Item, series and typed TMDB title rules (a rule made on an absent
    /// title keeps working when it arrives, D46); a movie's or series' own rule hides the whole title, any other item rule
    /// only that item. A file that can't be read is "can't be read now", never "nothing hidden".
    /// The D46 HiddenContentPolicy replaces this adapter when the tracks are joined (same rules, same surface).
    /// </summary>
    public sealed class JellyfinReadyPrivacy : IReadyPrivacy
    {
        private const string FileName = "hidden-content.json";

        private readonly UserConfigurationManager _files;
        private readonly Func<PluginConfiguration?> _config;

        /// <summary>Creates the reader (DI).</summary>
        public JellyfinReadyPrivacy(UserConfigurationManager files)
            : this(files, null)
        {
        }

        /// <summary>Creates the reader with an explicit configuration (tests).</summary>
        internal JellyfinReadyPrivacy(UserConfigurationManager files, Func<PluginConfiguration?>? config)
        {
            _files = files;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
        }

        /// <inheritdoc />
        public ReadyHides? Load(Guid userId)
        {
            if (_config()?.HiddenContentEnabled != true) return ReadyHides.None;
            var id = userId.ToString("N");
            UserHiddenContent data;
            try
            {
                lock (_files.GetUserFileLock(id, FileName))
                    data = _files.GetUserConfigurationStrict<UserHiddenContent>(id, FileName, quarantineCorrupt: false);
            }
            catch (Exception)
            {
                return null;
            }

            return From(data);
        }

        /// <summary>The rules of a Hidden Content document for the library surface.</summary>
        internal static ReadyHides From(UserHiddenContent? data)
        {
            var settings = data?.Settings ?? new HiddenContentSettings();
            if (data == null || !settings.Enabled || !settings.FilterLibrary) return ReadyHides.None;
            var items = new List<Guid>();
            var series = new List<Guid>();
            var titles = new List<string>();
            var titleItems = new List<Guid>();
            foreach (var pair in data.Items ?? new Dictionary<string, HiddenContentItem>())
            {
                var entry = pair.Value;
                if (entry == null) continue;
                var scope = string.IsNullOrEmpty(entry.HideScope) ? "global" : entry.HideScope.ToLowerInvariant();
                if (scope is not ("global" or "library")) continue;
                var kind = entry.Type?.ToLowerInvariant() switch { "movie" => "movie", "series" or "tv" => "tv", _ => null };
                if (Guid.TryParse(entry.ItemId, out var item) && item != Guid.Empty)
                {
                    // That item itself; a movie's or series' own rule is the whole title's (every copy), as Hidden Content
                    // keys it (D46); an episode, version or other item rule is that item's only.
                    items.Add(item);
                    if (kind != null) titleItems.Add(item);
                    if (string.Equals(entry.Type, "Series", StringComparison.OrdinalIgnoreCase)) series.Add(item);
                }

                if (kind != null && int.TryParse(entry.TmdbId, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var tmdb) && tmdb > 0)
                    titles.Add(kind + ":tmdb:" + tmdb.ToString(System.Globalization.CultureInfo.InvariantCulture));
                else if (TitleKey.Parse(pair.Key) is { Provider: "tmdb", Season: null, NumericId: > 0 } key)
                    titles.Add((key.IsMovie ? "movie" : "tv") + ":tmdb:" + key.NumericId!.Value.ToString(System.Globalization.CultureInfo.InvariantCulture));
            }

            return items.Count + titles.Count == 0 ? ReadyHides.None : new ReadyHides(items, series, titles.Distinct(), titleItems);
        }
    }

    /// <summary>
    /// Jellyfin's library and watch events for the Ready playlist: each only reads the item it is about and queues a look
    /// (<see cref="ReadyPlaylistService"/>: an epoch bump and a bounded queue). No database, no lock and no wait on the event
    /// thread, and never anything while the switch is off.
    /// </summary>
    public sealed class ReadyLibraryEvents : IHostedService
    {
        private readonly ILibraryManager _library;
        private readonly IUserDataManager _userData;
        private readonly ReadyPlaylistService _service;

        /// <summary>Creates the listener (DI).</summary>
        public ReadyLibraryEvents(ILibraryManager library, IUserDataManager userData, ReadyPlaylistService service)
        {
            _library = library;
            _userData = userData;
            _service = service;
        }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            _library.ItemAdded += OnChanged;
            _library.ItemUpdated += OnChanged;
            _library.ItemRemoved += OnRemoved;
            _userData.UserDataSaved += OnUserData;
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public Task StopAsync(CancellationToken cancellationToken)
        {
            _library.ItemAdded -= OnChanged;
            _library.ItemUpdated -= OnChanged;
            _library.ItemRemoved -= OnRemoved;
            _userData.UserDataSaved -= OnUserData;
            return Task.CompletedTask;
        }

        private static bool On() => ReadyFlags.Playlist(JellyfinEnhanced.Instance?.Configuration);

        private void OnChanged(object? sender, ItemChangeEventArgs e)
        {
            try
            {
                if (!On()) return;
                var keys = e?.Item switch
                {
                    Movie movie => TitleAliases.FromProviderIds(true, movie.GetProviderId(MetadataProvider.Tmdb), null, movie.GetProviderId(MetadataProvider.Imdb)),
                    Episode episode when episode.Series is { } series => TitleAliases.FromProviderIds(false, series.GetProviderId(MetadataProvider.Tmdb), series.GetProviderId(MetadataProvider.Tvdb), series.GetProviderId(MetadataProvider.Imdb)),
                    _ => null,
                };
                if (keys != null) _service.OnArrival(keys);
            }
            catch (Exception)
            {
                // A library event must never fail because of the Ready playlist.
            }
        }

        private void OnRemoved(object? sender, ItemChangeEventArgs e)
        {
            try
            {
                if (!On() || e?.Item is not { } item) return;
                if (item is Playlist) _service.OnItemRemoved(item.Id, true);
                else if (item is Video) _service.OnItemRemoved(item.Id, false);
            }
            catch (Exception)
            {
                // Never fail Jellyfin's deletion.
            }
        }

        private void OnUserData(object? sender, UserDataSaveEventArgs e)
        {
            try
            {
                if (e == null || e.UserId == Guid.Empty || e.UserData?.Played != true || !On()) return;
                if (e.SaveReason is UserDataSaveReason.PlaybackFinished or UserDataSaveReason.TogglePlayed or UserDataSaveReason.UpdateUserData) _service.MarkDirty(e.UserId);
            }
            catch (Exception)
            {
                // Never fail a playback report.
            }
        }
    }

    /// <summary>A person's Jellyfin account changed (library access, parental limits, disabled): their Ready playlist gets a look.</summary>
    public sealed class ReadyUserEvents : IEventConsumer<UserUpdatedEventArgs>
    {
        private readonly ReadyPlaylistService _service;

        /// <summary>Creates the consumer (DI).</summary>
        public ReadyUserEvents(ReadyPlaylistService service)
        {
            _service = service;
        }

        /// <inheritdoc />
        public Task OnEvent(UserUpdatedEventArgs eventArgs)
        {
            if (eventArgs?.Argument is { } user && ReadyFlags.Playlist(JellyfinEnhanced.Instance?.Configuration)) _service.MarkDirty(user.Id);
            return Task.CompletedTask;
        }
    }
}
