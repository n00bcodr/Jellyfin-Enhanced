using System;
using System.Collections.Concurrent;
using System.Threading;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags
{
    // Effective per-user native poster tag settings, cached so both hot paths
    // (DTO stamping on every authenticated item response, and image requests)
    // pay one dictionary lookup instead of a settings.json read + parse.
    //
    // Hands PosterTagSettings.FromSettingsJson the RAW settings.json text, which
    // it reads exactly as the server reads the file for the web (lenient syntax,
    // case-insensitive keys, nulls skipped, defaults on any error) and tells "no
    // file yet" (null) from "a file that yields nothing" (empty).
    //
    // Invalidation:
    //   - UserConfigurationManager.UserConfigurationSaved("settings.json") — the
    //     single write choke point for that file (settings POST, first-GET
    //     defaults, admin "apply defaults to all users");
    //   - plugin configuration saves: JellyfinEnhanced.UpdateConfiguration
    //     replaces the Configuration object, so a snapshot built from another
    //     instance is stale (reference check, no hook needed);
    //   - the user's Jellyfin audio language preference (an input of the
    //     quality tag's audio rule): Jellyfin raises no event when a user's
    //     configuration changes, so the snapshot remembers the value it was
    //     built with and is stale once the current one differs. The current
    //     value comes from PosterTagUserCache, so a change applies within
    //     its ~30 s TTL;
    //   - a TTL as belt-and-braces for hand edits of the file.
    public sealed class PosterTagSettingsProvider : IDisposable
    {
        private const string SettingsFileName = "settings.json";
        private const int MaxEntries = 4096;
        private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(2);

        private sealed record Snapshot(PosterTagSettings Settings, PluginConfiguration Config, string? AudioLanguagePreference, DateTime CreatedAt, long Generation);

        private readonly UserConfigurationManager _userConfig;
        private readonly PosterTagUserCache _users;
        private readonly ConcurrentDictionary<Guid, Snapshot> _cache = new();

        // Bumped by every invalidation. A read that raced a save (read the old
        // file, then stored its snapshot after the save's invalidation) is
        // recognised by its older generation and never served.
        private long _generation;

        public PosterTagSettingsProvider(UserConfigurationManager userConfig, PosterTagUserCache users)
        {
            _userConfig = userConfig;
            _users = users;
            _userConfig.UserConfigurationSaved += OnUserConfigurationSaved;
        }

        /// <summary>The user's effective settings for the current plugin configuration.</summary>
        public PosterTagSettings Get(Guid userId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration ?? new PluginConfiguration();
            var now = DateTime.UtcNow;
            var generation = Interlocked.Read(ref _generation);
            var audioPreference = _users.Get(userId)?.AudioLanguagePreference;
            if (_cache.TryGetValue(userId, out var hit)
                && hit.Generation == generation
                && ReferenceEquals(hit.Config, config)
                && string.Equals(hit.AudioLanguagePreference, audioPreference, StringComparison.Ordinal)
                && now - hit.CreatedAt < Ttl)
            {
                return hit.Settings;
            }

            // TryReadUserConfigurationText already yields FromSettingsJson's input
            // contract: null = no settings.json yet, empty = present but unreadable.
            var text = _userConfig.TryReadUserConfigurationText(userId.ToString("N"), SettingsFileName);
            var settings = PosterTagSettings.FromSettingsJson(text, config, audioPreference);
            if (_cache.Count >= MaxEntries) _cache.Clear();
            _cache[userId] = new Snapshot(settings, config, audioPreference, now, generation);
            return settings;
        }

        /// <summary>Drops a user's cached settings.</summary>
        public void Invalidate(Guid userId)
        {
            Interlocked.Increment(ref _generation);
            _cache.TryRemove(userId, out _);
        }

        public void Dispose()
        {
            _userConfig.UserConfigurationSaved -= OnUserConfigurationSaved;
        }

        private void OnUserConfigurationSaved(string userIdN, string fileName)
        {
            if (!string.Equals(fileName, SettingsFileName, StringComparison.OrdinalIgnoreCase)) return;
            if (Guid.TryParse(userIdN, out var userId)) Invalidate(userId);
        }
    }
}
