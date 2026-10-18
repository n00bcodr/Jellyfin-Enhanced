using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// Credential access for <see cref="PluginConfiguration"/>. Credential properties hold
    /// <see cref="SecretValue"/> placeholders once the secrets store has them; code that needs the
    /// real value reads it through these methods (never the property). Methods, not properties, so
    /// no serializer can ever pick them up.
    /// </summary>
    public partial class PluginConfiguration
    {
        /// <summary>
        /// Every credential stored in the plugin configuration, by property name (also the name it
        /// is stored under in the secrets store). Arr instance keys inside <see cref="SonarrInstances"/>
        /// and <see cref="RadarrInstances"/> are stored per instance id instead. A test fails when a
        /// new credential-like property is added without being listed here.
        /// </summary>
        public static readonly IReadOnlyList<string> StoredSecretFields = new[]
        {
            nameof(TMDB_API_KEY),
            nameof(MdblistApiKey),
            nameof(JellyseerrApiKey),
            nameof(ShokoApiKey),
            nameof(SonarrApiKey),
            nameof(RadarrApiKey),
            nameof(AnalyticsInstallSecret),
            nameof(BackupPassphrase),
            nameof(ArrNtfyToken),
            nameof(ArrSmtpPassword),
            // Phase 4c2: list sources
            nameof(ArrListTraktApiKey),
        };

        /// <summary>The real Seerr API key.</summary>
        public string GetJellyseerrApiKey() => GetSecret(nameof(JellyseerrApiKey));

        /// <summary>The real TMDB API key.</summary>
        public string GetTmdbApiKey() => GetSecret(nameof(TMDB_API_KEY));

        /// <summary>The real MDBList API key.</summary>
        public string GetMdblistApiKey() => GetSecret(nameof(MdblistApiKey));

        /// <summary>The real Trakt client id for list sources (Phase 4c2).</summary>
        public string GetListTraktApiKey() => GetSecret(nameof(ArrListTraktApiKey));

        /// <summary>The real Shoko API key.</summary>
        public string GetShokoApiKey() => GetSecret(nameof(ShokoApiKey));

        /// <summary>The real passphrase for credentials in scheduled backups.</summary>
        public string GetBackupPassphrase() => GetSecret(nameof(BackupPassphrase));

        /// <summary>The real analytics install secret.</summary>
        public string GetAnalyticsInstallSecret() => GetSecret(nameof(AnalyticsInstallSecret));

        /// <summary>
        /// Stores the analytics install secret (server-minted, never shown in the UI) through the
        /// secrets store, leaving only its placeholder on this object. Empty clears it.
        /// </summary>
        public void SetAnalyticsInstallSecret(string? value) => SetSecret(nameof(AnalyticsInstallSecret), value);

        /// <summary>
        /// The real value of the credential property <paramref name="field"/> (one of
        /// <see cref="StoredSecretFields"/>): a placeholder resolves from the secrets store, a raw
        /// value (not migrated yet, or set directly by code) is returned as is. "" when unset.
        /// </summary>
        public string GetSecret(string field) => ResolveStoredValue(ReadField(field), field);

        /// <summary>
        /// Stores a credential: in the secrets store with a placeholder on this object when a store
        /// is available and writable; otherwise (unit tests, early start-up, a store that can't be
        /// written) the raw value stays on the property until the next start-up migration moves it.
        /// </summary>
        public void SetSecret(string field, string? value)
        {
            var store = JellyfinEnhanced.Instance?.Secrets;
            if (store == null)
            {
                WriteField(field, value ?? string.Empty);
                return;
            }
            try
            {
                store.Set(field, value);
            }
            catch (SecretsStoreUnavailableException)
            {
                // The store can't be written: keep the value on the property (the pre-store layout);
                // the next start-up migration moves it once the store is writable again.
                WriteField(field, value ?? string.Empty);
                return;
            }
            WriteField(field, SecretValue.Mask(value));
        }

        /// <summary>
        /// Resolves a stored placeholder: a mask returns the value stored under
        /// <paramref name="storeName"/>, a raw value is returned unchanged, and an import handle or
        /// clear token (which only exist in flight) resolve to "".
        /// </summary>
        internal static string ResolveStoredValue(string? fieldValue, string? storeName)
        {
            if (string.IsNullOrEmpty(fieldValue) || SecretValue.IsClear(fieldValue)) return string.Empty;
            if (!SecretValue.IsPlaceholder(fieldValue)) return fieldValue;
            if (SecretValue.IsHandle(fieldValue) || storeName == null) return string.Empty;
            return JellyfinEnhanced.Instance?.Secrets?.Get(storeName) ?? string.Empty;
        }

        private static readonly Dictionary<string, System.Reflection.PropertyInfo> SecretProperties =
            StoredSecretFields.ToDictionary(f => f, f => typeof(PluginConfiguration).GetProperty(f)!, StringComparer.Ordinal);

        internal string ReadField(string field)
            => SecretProperties.TryGetValue(field, out var p) ? p.GetValue(this) as string ?? string.Empty : string.Empty;

        internal void WriteField(string field, string value)
        {
            if (!SecretProperties.TryGetValue(field, out var property))
                throw new ArgumentException("Unknown credential property " + field, nameof(field));
            property.SetValue(this, value);
        }

        /// <summary>True when <paramref name="field"/> is one of <see cref="StoredSecretFields"/>.</summary>
        public static bool IsStoredSecretField(string field) => StoredSecretFields.Contains(field, StringComparer.Ordinal);
    }
}
