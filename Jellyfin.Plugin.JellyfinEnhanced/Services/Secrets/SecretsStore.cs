using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets
{
    /// <summary>
    /// The sidecar file that holds every credential JE stores (Seerr, TMDB, MDBList, Shoko and arr API
    /// keys, the analytics install secret). It lives next to JE's other data files in the plugin
    /// configuration folder, is written owner-only (0600) and atomically, and is never served by any
    /// endpoint. The plugin XML keeps only <see cref="SecretValue"/> placeholders.
    ///
    /// Thread-safe. Values are cached in memory after the first read; every change is written through.
    /// The file is plain JSON so an admin can recover or roll back by hand (see docs).
    ///
    /// When the file exists but can't be read (locked, unreadable, not the expected JSON shape) the
    /// store is <see cref="IsAvailable">unavailable</see>: it reads as empty, refuses every write (so
    /// the file is never overwritten) and retries the read at most every
    /// <see cref="ReloadInterval"/>. A write that fails (read-only folder, full disk) throws
    /// <see cref="SecretsStoreUnavailableException"/> and changes nothing in memory.
    /// </summary>
    public sealed class SecretsStore
    {
        /// <summary>File name inside the JE data folder.</summary>
        public const string FileName = "secrets.json";

        /// <summary>Store name prefix for an arr instance's API key (followed by the instance id).</summary>
        public const string ArrKeyPrefix = "arr:";

        /// <summary>How often an unavailable store retries reading its file.</summary>
        public static readonly TimeSpan ReloadInterval = TimeSpan.FromSeconds(30);

        private const int FormatVersion = 1;
        private static readonly TimeSpan DefaultHandleTtl = TimeSpan.FromMinutes(30);

        private readonly string _path;
        private readonly Action<string> _warn;
        private readonly object _lock = new();
        private readonly Func<DateTimeOffset> _now;
        private Dictionary<string, string>? _values;
        private string? _unavailableReason;
        private DateTimeOffset _loadFailedAt;
        private bool _warnedUnavailable;
        private readonly Dictionary<string, (string Value, string? BoundUrl, DateTimeOffset Expires)> _pending = new(StringComparer.Ordinal);

        /// <summary>Creates a store backed by <paramref name="path"/>.</summary>
        /// <param name="path">Full path of the sidecar file.</param>
        /// <param name="warn">Receives warnings (never secret values).</param>
        /// <param name="now">Clock for import-handle expiry (tests).</param>
        public SecretsStore(string path, Action<string>? warn = null, Func<DateTimeOffset>? now = null)
        {
            _path = path;
            _warn = warn ?? (_ => { });
            _now = now ?? (() => DateTimeOffset.UtcNow);
            EvidenceRevision.Advance(() => Version.Mutate(() => _values = Load()));
        }

        /// <summary>The store's default location for a Jellyfin installation.</summary>
        public static string DefaultPath(IApplicationPaths paths)
            => Path.Combine(paths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", FileName);

        /// <summary>The store name used for an arr instance's key.</summary>
        public static string ArrKeyName(string instanceId) => ArrKeyPrefix + instanceId;

        /// <summary>
        /// The version of what the store holds (a <see cref="FactVersion"/>): every change of its values, on disk and in
        /// memory, is made inside its bracket (the automatic-write check reads whether Seerr's API key is stored).
        /// </summary>
        public FactVersion Version { get; } = new();

        /// <summary>Full path of the sidecar file.</summary>
        public string FilePath => _path;

        /// <summary>
        /// False while the file exists but could not be read: nothing is stored or removed until it
        /// can be (the admin fixes or removes the file, or a transient lock clears).
        /// </summary>
        public bool IsAvailable
        {
            get
            {
                RecoverIfNeeded();
                lock (_lock)
                {
                    return _unavailableReason == null;
                }
            }
        }

        /// <summary>Why the store is unavailable (no secret values), or null.</summary>
        public string? UnavailableReason
        {
            get
            {
                RecoverIfNeeded();
                lock (_lock)
                {
                    return _unavailableReason;
                }
            }
        }

        /// <summary>The stored value, or null.</summary>
        public string? Get(string name)
        {
            RecoverIfNeeded();
            lock (_lock)
            {
                return Values().TryGetValue(name, out var v) ? v : null;
            }
        }

        /// <summary>Names of every stored credential (never the values).</summary>
        public IReadOnlyList<string> Names()
        {
            RecoverIfNeeded();
            lock (_lock)
            {
                return Values().Keys.OrderBy(k => k, StringComparer.Ordinal).ToList();
            }
        }

        /// <summary>
        /// Applies several stores/removals (empty value = remove) with one write. Throws
        /// <see cref="SecretsStoreUnavailableException"/> when the store can't be written.
        /// </summary>
        public void Apply(IReadOnlyDictionary<string, string> changes) => Update(values =>
        {
            var changed = false;
            foreach (var (name, value) in changes)
            {
                if (string.IsNullOrEmpty(value)) changed |= values.Remove(name);
                else if (!values.TryGetValue(name, out var existing) || existing != value)
                {
                    values[name] = value;
                    changed = true;
                }
            }
            return changed;
        });

        /// <summary>Stores (or replaces) a credential and writes the file. Empty values remove it.</summary>
        public void Set(string name, string? value) => Update(values =>
        {
            if (string.IsNullOrEmpty(value)) return values.Remove(name);
            if (values.TryGetValue(name, out var existing) && existing == value) return false;
            values[name] = value;
            return true;
        });

        /// <summary>Removes a credential. Returns true if it existed.</summary>
        public bool Remove(string name)
        {
            var removed = false;
            Update(values => removed = values.Remove(name));
            return removed;
        }

        /// <summary>
        /// Applies several changes under one lock and writes the file once if anything changed.
        /// <paramref name="mutate"/> returns true when it changed the dictionary. Throws
        /// <see cref="SecretsStoreUnavailableException"/> (and keeps the previous values) when the
        /// store is unavailable or the file can't be written.
        /// </summary>
        public void Update(Func<Dictionary<string, string>, bool> mutate)
        {
            RecoverIfNeeded();
            EvidenceRevision.Advance(() => UpdateUnderBarrier(mutate));
        }

        private void UpdateUnderBarrier(Func<Dictionary<string, string>, bool> mutate)
        {
            lock (_lock)
            {
                var copy = new Dictionary<string, string>(Values(), StringComparer.Ordinal);
                if (!mutate(copy)) return;
                if (_unavailableReason != null)
                {
                    throw new SecretsStoreUnavailableException($"{FileName} could not be read ({_unavailableReason}); it is left untouched until it can be.");
                }
                try
                {
                    // On disk and in memory inside the version's bracket.
                    Version.Mutate(() =>
                    {
                        Write(copy);
                        _values = copy;
                    });
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    throw new SecretsStoreUnavailableException($"{FileName} could not be written ({ex.GetType().Name}: {ex.Message}).", ex);
                }
            }
        }

        /// <summary>
        /// Holds a credential read server-side (for example from Seerr) until the admin saves, and
        /// returns the handle to hand to the browser instead of the credential. When
        /// <paramref name="boundUrl"/> is given the handle only resolves for that server.
        /// </summary>
        public string AddPending(string value, string? boundUrl = null, TimeSpan? ttl = null)
        {
            var id = Convert.ToHexString(RandomNumberGenerator.GetBytes(12)).ToLowerInvariant();
            lock (_lock)
            {
                var now = _now();
                foreach (var expired in _pending.Where(p => p.Value.Expires <= now).Select(p => p.Key).ToList())
                {
                    _pending.Remove(expired);
                }
                _pending[id] = (value, boundUrl, now + (ttl ?? DefaultHandleTtl));
            }
            return SecretValue.CreateHandle(id);
        }

        /// <summary>
        /// The credential behind an unexpired import handle, or null. A handle bound to a server only
        /// resolves when <paramref name="targetUrl"/> is that server.
        /// </summary>
        public string? ResolvePending(string? handle, string? targetUrl = null)
        {
            var id = SecretValue.HandleId(handle);
            if (id == null) return null;
            lock (_lock)
            {
                if (!_pending.TryGetValue(id, out var entry) || entry.Expires <= _now()) return null;
                if (entry.BoundUrl != null && !SameServer(entry.BoundUrl, targetUrl)) return null;
                return entry.Value;
            }
        }

        /// <summary>
        /// The real value behind something a browser posted for a Test button: a raw credential is
        /// returned as is, an import handle is resolved, a mask resolves to the stored value
        /// <paramref name="storedName"/>. A stored or imported credential is only released for the
        /// server it belongs to: when <paramref name="targetUrl"/> is given it must be the same server
        /// (scheme, host, port) as one of <paramref name="savedUrls"/> (masks) or the handle's server,
        /// so a masked key can't be "tested" against some other address. Returns "" for a blank value,
        /// the clear token or anything that can't be resolved.
        /// </summary>
        public string ResolveSubmitted(string? submitted, string? storedName, string? targetUrl = null, IEnumerable<string?>? savedUrls = null)
        {
            submitted = SecretValue.FromWire(submitted);
            if (string.IsNullOrWhiteSpace(submitted) || SecretValue.IsClear(submitted)) return string.Empty;
            if (SecretValue.IsHandle(submitted)) return ResolvePending(submitted, targetUrl) ?? string.Empty;
            if (SecretValue.IsPlaceholder(submitted))
            {
                if (storedName == null) return string.Empty;
                if (targetUrl != null && savedUrls != null && !savedUrls.Any(u => SameServer(u, targetUrl))) return string.Empty;
                return Get(storedName) ?? string.Empty;
            }
            return submitted.Trim();
        }

        /// <summary>True when both URLs point at the same scheme, host and port.</summary>
        public static bool SameServer(string? a, string? b)
        {
            if (!Uri.TryCreate((a ?? string.Empty).Trim(), UriKind.Absolute, out var x) || !Uri.TryCreate((b ?? string.Empty).Trim(), UriKind.Absolute, out var y)) return false;
            return string.Equals(x.Scheme, y.Scheme, StringComparison.OrdinalIgnoreCase)
                && string.Equals(x.IdnHost, y.IdnHost, StringComparison.OrdinalIgnoreCase)
                && x.Port == y.Port;
        }

        // Snapshot reads never load or mutate. In particular, commit validation cannot start a draining writer.
        private Dictionary<string, string> Values() => _values!;

        internal void RecoverIfNeeded()
        {
            if (EvidenceRevision.ReadingSnapshot) return;
            lock (_lock)
            {
                if (_unavailableReason == null || _now() - _loadFailedAt < ReloadInterval) return;
            }
            EvidenceRevision.Advance(() =>
            {
                lock (_lock)
                {
                    if (_unavailableReason == null || _now() - _loadFailedAt < ReloadInterval) return;
                    var values = Version.Mutate(() => _values = Load());
                    if (_unavailableReason == null && _warnedUnavailable)
                    {
                        _warnedUnavailable = false;
                        _warn($"Secrets store {FileName} is readable again.");
                    }
                }
            });
        }

        // Caller holds _lock. Never moves, renames or rewrites an unreadable file: it stays exactly
        // where it is (for a transient lock, or for the admin to fix) and the store is unavailable.
        private Dictionary<string, string> Load()
        {
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            _unavailableReason = null;
            if (!File.Exists(_path)) return result;
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(_path));
                if (doc.RootElement.ValueKind != JsonValueKind.Object)
                {
                    return Unavailable($"the top level is {doc.RootElement.ValueKind}, not an object");
                }
                if (doc.RootElement.TryGetProperty("secrets", out var secrets))
                {
                    if (secrets.ValueKind != JsonValueKind.Object) return Unavailable($"\"secrets\" is {secrets.ValueKind}, not an object");
                    foreach (var p in secrets.EnumerateObject())
                    {
                        if (p.Value.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(p.Value.GetString()))
                        {
                            result[p.Name] = p.Value.GetString()!;
                        }
                    }
                }
                TightenPermissions();
                return result;
            }
            catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                return Unavailable(ex.GetType().Name);
            }
        }

        private Dictionary<string, string> Unavailable(string reason)
        {
            _unavailableReason = reason;
            _loadFailedAt = _now();
            if (_warnedUnavailable) return new Dictionary<string, string>(StringComparer.Ordinal);
            _warnedUnavailable = true;
            _warn($"Secrets store {FileName} could not be read ({reason}). It is left as is and nothing is written to it; stored credentials are unavailable until the file is fixed (or removed) — see the Stored credentials section of the docs. Retrying every {ReloadInterval.TotalSeconds:0} seconds.");
            return new Dictionary<string, string>(StringComparer.Ordinal);
        }

        private void Write(Dictionary<string, string> values)
        {
            var dir = Path.GetDirectoryName(_path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            var payload = JsonSerializer.SerializeToUtf8Bytes(new
            {
                version = FormatVersion,
                note = "Jellyfin Enhanced credentials. Keep private; never share this file.",
                secrets = values.OrderBy(k => k.Key, StringComparer.Ordinal).ToDictionary(k => k.Key, k => k.Value),
            }, new JsonSerializerOptions { WriteIndented = true });

            var temp = _path + ".tmp." + Guid.NewGuid().ToString("N");
            try
            {
                var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
                if (!OperatingSystem.IsWindows())
                {
                    options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
                }
                using (var stream = new FileStream(temp, options))
                {
                    stream.Write(payload, 0, payload.Length);
                    stream.Flush(true);
                }
                File.Move(temp, _path, overwrite: true);
            }
            finally
            {
                try { if (File.Exists(temp)) File.Delete(temp); }
                catch (Exception) { /* best effort */ }
            }
        }

        private void TightenPermissions()
        {
            if (OperatingSystem.IsWindows()) return;
            try
            {
                const UnixFileMode ownerOnly = UnixFileMode.UserRead | UnixFileMode.UserWrite;
                if ((File.GetUnixFileMode(_path) & ~ownerOnly) != 0) File.SetUnixFileMode(_path, ownerOnly);
            }
            catch (Exception ex)
            {
                _warn($"Could not restrict permissions of {FileName}: {ex.Message}");
            }
        }
    }

    /// <summary>The secrets store can't be read or written; nothing was changed.</summary>
    public sealed class SecretsStoreUnavailableException : Exception
    {
        /// <summary>Creates the exception.</summary>
        public SecretsStoreUnavailableException(string message, Exception? inner = null)
            : base(message, inner)
        {
        }
    }
}
