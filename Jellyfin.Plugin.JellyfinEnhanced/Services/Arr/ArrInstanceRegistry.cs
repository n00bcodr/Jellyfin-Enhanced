using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>
    /// Instance registry v2: the typed, id-addressed view of the configured Sonarr and Radarr
    /// instances. Still backed by the <c>SonarrInstances</c>/<c>RadarrInstances</c> JSON (so the
    /// existing features read the same rows), parsed once per configuration change rather than per
    /// call. Credentials are not part of it; <see cref="ResolveApiKey"/> reads them from the
    /// secrets store on demand.
    /// </summary>
    public sealed class ArrInstanceRegistry
    {
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<SecretsStore?> _secrets;
        private readonly object _lock = new();
        private (string Sonarr, string Radarr, IReadOnlyList<ArrConnection> All)? _cache;

        /// <summary>Registry over the live plugin configuration.</summary>
        public ArrInstanceRegistry()
            : this(() => JellyfinEnhanced.Instance?.Configuration, () => JellyfinEnhanced.Instance?.Secrets)
        {
        }

        /// <summary>Registry over explicit sources (tests).</summary>
        internal ArrInstanceRegistry(Func<PluginConfiguration?> config, Func<SecretsStore?> secrets)
        {
            _config = config;
            _secrets = secrets;
        }

        /// <summary>
        /// Every registered instance (Sonarr first, then Radarr, in configured order). Rows without
        /// an id (a list the start-up migration could not rewrite) are skipped; corrupt lists are empty.
        /// </summary>
        public IReadOnlyList<ArrConnection> All()
        {
            var config = _config();
            if (config == null) return Array.Empty<ArrConnection>();
            var sonarr = config.SonarrInstances ?? string.Empty;
            var radarr = config.RadarrInstances ?? string.Empty;
            lock (_lock)
            {
                if (_cache is { } c && ReferenceEquals(c.Sonarr, sonarr) && ReferenceEquals(c.Radarr, radarr)) return c.All;
            }

            var all = Rows(sonarr, ArrKind.Sonarr).Concat(Rows(radarr, ArrKind.Radarr)).ToList();
            lock (_lock)
            {
                _cache = (sonarr, radarr, all);
            }
            return all;
        }

        /// <summary>The instance with this id, or null.</summary>
        public ArrConnection? Get(string? id)
            => string.IsNullOrWhiteSpace(id) ? null : All().FirstOrDefault(c => string.Equals(c.Id, id.Trim(), StringComparison.OrdinalIgnoreCase));

        /// <summary>Enabled, non-retired instances of a kind.</summary>
        public IReadOnlyList<ArrConnection> Usable(ArrKind kind) => All().Where(c => c.Kind == kind && c.Usable).ToList();

        /// <summary>
        /// The instance to use for a kind and role: the flagged default among usable instances of that
        /// role, else the first usable one of that role. Anime falls back to the standard instance
        /// (there may be no anime instance); 4K and custom never fall back, so a 4K request is never
        /// silently sent to the standard instance.
        /// </summary>
        public ArrConnection? DefaultFor(ArrKind kind, string role)
        {
            role = ArrInstanceRole.Normalize(role);
            var candidates = Usable(kind).Where(c => c.Role == role).ToList();
            var pick = candidates.FirstOrDefault(c => c.IsDefault) ?? candidates.FirstOrDefault();
            if (pick == null && role == ArrInstanceRole.Anime) return DefaultFor(kind, ArrInstanceRole.Standard);
            return pick;
        }

        /// <summary>The real API key for an instance ("" when none is stored).</summary>
        public string ResolveApiKey(ArrConnection connection)
        {
            var stored = connection.StoredKey;
            if (string.IsNullOrEmpty(stored)) return string.Empty;
            if (!SecretValue.IsPlaceholder(stored)) return stored;
            if (SecretValue.IsHandle(stored)) return string.Empty;
            return _secrets()?.Get(SecretsStore.ArrKeyName(connection.Id)) ?? string.Empty;
        }

        /// <summary>A display hint for the stored key ("ends 3f9a"), never the key.</summary>
        public string KeyHint(ArrConnection connection) => SecretValue.Hint(ResolveApiKey(connection));

        private static IEnumerable<ArrConnection> Rows(string json, ArrKind kind)
            => (ArrRegistryMigration.Parse(json) ?? new List<ArrInstance>())
                .Where(r => ArrRegistryMigration.IsValidId(r.Id) && !string.IsNullOrWhiteSpace(r.Url))
                .Select(r => ArrConnection.FromRow(r, kind));
    }
}
