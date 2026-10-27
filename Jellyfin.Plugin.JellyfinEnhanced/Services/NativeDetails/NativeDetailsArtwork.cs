#if JF12
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>An artwork grant read back from an image tag.</summary>
    /// <param name="Owner">The item id the image is requested for (the URL's item id).</param>
    /// <param name="Type">Image type.</param>
    /// <param name="Index">Image index.</param>
    /// <param name="Path">Fixed TMDB file path.</param>
    /// <param name="Viewer">The viewer the grant was minted for.</param>
    /// <param name="PolicyRevision">The viewer's policy revision when minted.</param>
    /// <param name="Context">
    /// The page the grant was minted for (a title, or a person's own page): a cast photo on a title's page
    /// is served while that title is still the viewer's, not just while the person is.
    /// </param>
    /// <param name="IssuedHour">The hour the grant was minted in (hours since the Unix epoch).</param>
    public sealed record ArtworkGrant(Guid Owner, ImageType Type, int Index, string Path, Guid Viewer, string PolicyRevision, Guid Context, long IssuedHour, string SpoilerRevision = "");

    /// <summary>
    /// Signed artwork grants and the TMDB image fetch behind them. A synthetic page's image tags are
    /// <c>na1.&lt;hex payload&gt;.&lt;hex HMAC-SHA256&gt;</c>: the payload (version 2) binds the image owner,
    /// type, index, the fixed TMDB file path, the viewer, the viewer's policy revision, the page it was
    /// minted for and the hour it was minted in. A grant lasts <see cref="GrantLifetimeHours"/> hours (a
    /// page open longer gets new ones when it is drawn again; within an hour the same image keeps the
    /// same tag); version-1 grants (no page, no time) are no longer accepted. Images are
    /// requested without credentials (plain &lt;img&gt;), so the grant is the authority: every GET/HEAD
    /// checks it against the viewer's current policy revision (parental rules, library access, feature
    /// and Seerr switches, import block) and re-runs the viewer's eligibility (Seerr linkage) and the
    /// page's: the title's (its artwork and the cast photos on it), or the person page's.
    /// Answers are never cacheable
    /// by the browser or a proxy (no 304). The key is kept in the plugin's data folder (owner-only),
    /// so a restart doesn't end the grants of pages that are open; without a data folder it lives in
    /// memory and a restart ends them (a reload mints new ones). A viewer's sign-out ends their grants
    /// through the policy revision. Fetches go only to https://image.tmdb.org, bounded in size, time
    /// and concurrency, behind a bounded byte cache of public source images; images not in that cache
    /// are fetched for one viewer at most at <see cref="UpstreamBurst"/> at once, then
    /// <see cref="UpstreamPerSecond"/> a second (a busy series page needs about 90). With the server-side
    /// cache on, fetched images are also kept on disk (<see cref="ServerBlobCache"/>, namespace
    /// <see cref="DiskNamespace"/>): an image read from there costs no upstream budget or admission place,
    /// survives a restart and is served with the content type it was fetched with.
    /// </summary>
    public sealed class NativeDetailsArtwork
    {
        /// <summary>The grant prefix (hex never contains JE's tag-decoration sentinels).</summary>
        public const string Prefix = "na1.";

        private const int HmacHexLength = 32;
        private const int MaxImageBytes = 8 * 1024 * 1024;
        private const long MaxCacheBytes = 64L * 1024 * 1024;
        private static readonly int[] Widths = { 92, 154, 185, 300, 342, 500, 780, 1280 };
        private static readonly Regex SafePath = new(@"^/[A-Za-z0-9_-]{1,80}\.(jpg|jpeg|png|webp)$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly TimeSpan FetchTimeout = TimeSpan.FromSeconds(10);
        private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(6);

        /// <summary>Upstream image fetches one viewer may start at once (a page's worth, several times over).</summary>
        public const int UpstreamBurst = 240;

        /// <summary>Upstream image fetches one viewer may start per second once the burst is used.</summary>
        public const double UpstreamPerSecond = 4;

        /// <summary>How long a grant is accepted after the hour it was minted in.</summary>
        public const int GrantLifetimeHours = 24;

        /// <summary>The server-side cache namespace of TMDB artwork.</summary>
        public const string DiskNamespace = "artwork";

        private const string KeyFile = "native-details-artwork.key";
        private readonly byte[] _key;
        private readonly IHttpClientFactory _http;
        private readonly ViewerBudget _budget;
        private readonly Func<DateTime> _now;
        private readonly ImageMetadataAdmission _images = new();
        private readonly ServerBlobCache? _disk;
        // OnDisk: nothing left to save (the image is, or was, in the server-side cache, or its save was superseded by a
        // Clear, Forget, folder change or switch-off). Generation: the server-side cache's generation from before the
        // bytes were fetched; every save of them carries it, so an invalidation since then refuses the save.
        private readonly ConcurrentDictionary<string, (byte[] Bytes, string ContentType, DateTime At, bool OnDisk, long Generation)> _bytes = new(StringComparer.Ordinal);
        private long _cachedBytes;

        /// <summary>Creates the artwork service with a key in memory.</summary>
        public NativeDetailsArtwork(IHttpClientFactory http)
            : this(http, null, null)
        {
        }

        /// <summary>Creates the artwork service with its key kept in <paramref name="keyDirectory"/>.</summary>
        /// <param name="http">HTTP clients.</param>
        /// <param name="keyDirectory">Folder for the grant key (the plugin's data folder), or null for memory only.</param>
        /// <param name="now">Clock (tests).</param>
        /// <param name="disk">The server-side cache, if any (it decides itself whether it is on).</param>
        public NativeDetailsArtwork(IHttpClientFactory http, string? keyDirectory, Func<DateTime>? now = null, ServerBlobCache? disk = null)
        {
            _http = http;
            _disk = disk;
            _disk?.Register(new ServerCacheNamespace(DiskNamespace, MaxEntryBytes: MaxImageBytes));
            _now = now ?? (() => DateTime.UtcNow);
            _budget = new ViewerBudget(UpstreamBurst, UpstreamPerSecond, _now);
            _key = LoadKey(keyDirectory);
        }

        /// <summary>
        /// The grant key from <paramref name="directory"/>, created there (owner-only) when missing;
        /// a fresh in-memory key when there is no folder or it can't be used.
        /// </summary>
        internal static byte[] LoadKey(string? directory)
        {
            if (string.IsNullOrWhiteSpace(directory)) return RandomNumberGenerator.GetBytes(32);
            try
            {
                var path = System.IO.Path.Combine(directory, KeyFile);
                if (System.IO.File.Exists(path))
                {
                    var stored = System.IO.File.ReadAllBytes(path);
                    if (stored.Length == 32) return stored;
                }

                System.IO.Directory.CreateDirectory(directory);
                var key = RandomNumberGenerator.GetBytes(32);
                using (var file = new System.IO.FileStream(path, System.IO.FileMode.Create, System.IO.FileAccess.Write, System.IO.FileShare.None))
                {
                    file.Write(key);
                }

                if (!OperatingSystem.IsWindows()) System.IO.File.SetUnixFileMode(path, System.IO.UnixFileMode.UserRead | System.IO.UnixFileMode.UserWrite);
                return key;
            }
            catch (Exception)
            {
                return RandomNumberGenerator.GetBytes(32);
            }
        }

        /// <summary>
        /// Takes one upstream fetch from a viewer's budget (images already in the byte cache cost
        /// nothing): <see cref="UpstreamBurst"/> at once, refilled at <see cref="UpstreamPerSecond"/>.
        /// </summary>
        /// <param name="viewer">The viewer the grant was minted for.</param>
        /// <returns>True when the fetch may start.</returns>
        internal bool TakeUpstream(Guid viewer) => _budget.Take(viewer);

        /// <summary>True when the image is in the byte cache (no upstream fetch needed).</summary>
        internal bool IsCached(string path, string size)
            => _bytes.TryGetValue(size + path, out var hit) && _now() - hit.At < CacheTtl;

        /// <summary>
        /// True when the image is in the byte cache or the server-side cache (read into the byte cache, so
        /// the fetch that follows is served from memory): no upstream fetch needed.
        /// </summary>
        /// <param name="path">A TMDB file path.</param>
        /// <param name="size">A TMDB size.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>Cached.</returns>
        internal async Task<bool> IsCachedAsync(string path, string size, CancellationToken ct)
            => IsCached(path, size) || (IsSafeTmdbPath(path) && await FromDiskAsync(size + path, ct).ConfigureAwait(false) != null);

        /// <summary>Upstream fetches made (for tests and the proof's measurements).</summary>
        public int UpstreamFetches => _upstreamFetches;

        /// <summary>Images served from the server-side cache (for tests and the proof's measurements).</summary>
        public int DiskHits => _diskHits;

        private int _upstreamFetches;
        private int _diskHits;

        /// <summary>True for a TMDB file path of the expected shape ("/abc123.jpg"); anything else is never fetched.</summary>
        /// <param name="path">Path.</param>
        /// <returns>Safe.</returns>
        public static bool IsSafeTmdbPath(string? path) => path != null && SafePath.IsMatch(path);

        /// <summary>The current hour (hours since the Unix epoch).</summary>
        private long Hour() => (long)Math.Floor((_now() - DateTime.UnixEpoch).TotalHours);

        /// <summary>Mints a grant tag, or null for an unsafe path.</summary>
        /// <param name="owner">The image's item id.</param>
        /// <param name="type">Image type.</param>
        /// <param name="index">Image index.</param>
        /// <param name="tmdbPath">TMDB file path.</param>
        /// <param name="viewer">The viewer.</param>
        /// <param name="policyRevision">The viewer's policy revision.</param>
        /// <param name="context">The page it is minted for (a title or a person's page); null: the owner itself.</param>
        /// <returns>The tag, or null.</returns>
        public string? Mint(Guid owner, ImageType type, int index, string? tmdbPath, Guid viewer, string policyRevision, Guid? context = null, string? spoilerRevision = null)
        {
            if (!IsSafeTmdbPath(tmdbPath)) return null;
            var payload = string.Join('|', "3", owner.ToString("N"), ((int)type).ToString(CultureInfo.InvariantCulture),
                index.ToString(CultureInfo.InvariantCulture), tmdbPath, viewer.ToString("N"), policyRevision,
                (context ?? owner).ToString("N"), Hour().ToString(CultureInfo.InvariantCulture), spoilerRevision ?? "");
            var bytes = Encoding.UTF8.GetBytes(payload);
            return Prefix + Convert.ToHexStringLower(bytes) + "." + Sign(bytes);
        }

        /// <summary>Reads and verifies a grant tag (signature, shape and age; policy is the caller's check).</summary>
        /// <param name="tag">The tag from the image request.</param>
        /// <param name="grant">The grant.</param>
        /// <returns>True when the tag is a genuine grant.</returns>
        public bool TryRead(string? tag, out ArtworkGrant? grant)
        {
            grant = null;
            if (tag == null || !tag.StartsWith(Prefix, StringComparison.Ordinal) || tag.Length > 2048) return false;
            var dot = tag.LastIndexOf('.');
            if (dot <= Prefix.Length || tag.Length - dot - 1 != HmacHexLength) return false;
            byte[] payload;
            try
            {
                payload = Convert.FromHexString(tag.AsSpan(Prefix.Length, dot - Prefix.Length));
            }
            catch (FormatException)
            {
                return false;
            }

            var expected = Encoding.ASCII.GetBytes(Sign(payload));
            var given = Encoding.ASCII.GetBytes(tag.Substring(dot + 1).ToLowerInvariant());
            if (!CryptographicOperations.FixedTimeEquals(expected, given)) return false;
            var parts = Encoding.UTF8.GetString(payload).Split('|');
            if (!((parts.Length == 9 && parts[0] == "2") || (parts.Length == 10 && parts[0] == "3"))
                || !Guid.TryParseExact(parts[1], "N", out var owner)
                || !int.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out var type)
                || !int.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out var index)
                || !IsSafeTmdbPath(parts[4])
                || !Guid.TryParseExact(parts[5], "N", out var viewer)
                || !Guid.TryParseExact(parts[7], "N", out var context)
                || !long.TryParse(parts[8], NumberStyles.None, CultureInfo.InvariantCulture, out var issued))
            {
                return false;
            }

            // Expired, or minted in the future (a clock that went back is no reason to accept one).
            var now = Hour();
            if (issued > now + 1 || now - issued >= GrantLifetimeHours) return false;
            grant = new ArtworkGrant(owner, (ImageType)type, index, parts[4], viewer, parts[6], context, issued, parts.Length == 10 ? parts[9] : "");
            return true;
        }

        /// <summary>The TMDB size for a requested width (bounded to w1280).</summary>
        /// <param name="type">Image type.</param>
        /// <param name="width">Requested width in pixels, if any.</param>
        /// <returns>A TMDB size name such as "w500".</returns>
        public static string SizeFor(ImageType type, int? width)
        {
            var want = width ?? (type == ImageType.Backdrop ? 1280 : 500);
            foreach (var w in Widths)
            {
                if (w >= want) return "w" + w.ToString(CultureInfo.InvariantCulture);
            }

            return "w1280";
        }

        /// <summary>Fetches a TMDB image (coalesced, cached, bounded); null when it can't be had.</summary>
        /// <param name="path">A safe TMDB file path.</param>
        /// <param name="size">A TMDB size from <see cref="SizeFor"/>.</param>
        /// <param name="ct">Cancellation for this caller.</param>
        /// <returns>The bytes and content type, or null.</returns>
        public Task<(byte[] Bytes, string ContentType)?> FetchAsync(string path, string size, CancellationToken ct)
            => FetchAsync(path, size, ViewerMetadataAdmission.EffectiveViewer ?? Guid.Empty, ct);

        /// <summary>Fetches public bytes under a separate, bounded image owner; privacy remains the facade's responsibility.</summary>
        /// <param name="path">A safe TMDB path.</param>
        /// <param name="size">A supported width.</param>
        /// <param name="viewer">The validated grant's viewer.</param>
        /// <param name="ct">Cancels this wait, not the shared operation.</param>
        /// <returns>Bytes, or null for bounded admission/queue refusal and upstream failure.</returns>
        public async Task<(byte[] Bytes, string ContentType)?> FetchAsync(string path, string size, Guid viewer, CancellationToken ct)
        {
            if (!IsSafeTmdbPath(path) || !Widths.Any(w => size == "w" + w.ToString(CultureInfo.InvariantCulture))) return null;
            var key = size + path;
            if (_bytes.TryGetValue(key, out var memory) && _now() - memory.At < CacheTtl)
            {
                // Shown while the server-side cache was off (or before it was switched on): saved now, once.
                if (!memory.OnDisk && _disk != null) await PersistAsync(key, memory).ConfigureAwait(false);
                return (memory.Bytes, memory.ContentType);
            }
            // Taken before the fetch: a Clear while it runs keeps its result off the disk.
            var generation = _disk?.Generation ?? 0;
            // Read before admission: a disk hit takes no admission place and makes no upstream request.
            if (await FromDiskAsync(key, ct).ConfigureAwait(false) is { } disk) return disk;
            return await _images.Read(key, viewer,
                () => _bytes.TryGetValue(key, out var hit) && _now() - hit.At < CacheTtl
                    ? ((byte[] Bytes, string ContentType)?)(hit.Bytes, hit.ContentType) : null,
                () => FetchUpstreamAsync(key: key, size: size, path: path, generation: generation), ct).ConfigureAwait(false);
        }

        /// <summary>An image from the server-side cache, kept in the byte cache too; null when it isn't there (or is off).</summary>
        private async Task<(byte[] Bytes, string ContentType)?> FromDiskAsync(string key, CancellationToken ct)
        {
            if (_disk == null) return null;
            var entry = await _disk.TryGetAsync(DiskNamespace, key, ct).ConfigureAwait(false);
            // Only what an upstream fetch would accept is served, with the type it was stored with.
            if (entry == null || !IsImageType(entry.ContentType) || entry.Bytes.Length > MaxImageBytes) return null;
            Interlocked.Increment(ref _diskHits);
            Store(key, entry.Bytes, entry.ContentType, onDisk: true, generation: 0);
            return (entry.Bytes, entry.ContentType);
        }

        /// <summary>
        /// Saves an image the byte cache holds but the server-side cache doesn't (fetched while that was off, or its save
        /// was skipped: disk busy, over the cap), with its fetch time and the generation from before its fetch, so the
        /// store refuses it after any Clear, Forget, folder change or switch-off since. Concurrent hits save it once. A save
        /// refused for being off, busy or over the cap is tried again on a later hit; one superseded by an invalidation
        /// never is, and neither is an image that was saved and then cleared.
        /// </summary>
        private async Task PersistAsync(string key, (byte[] Bytes, string ContentType, DateTime At, bool OnDisk, long Generation) memory)
        {
            var claimed = memory with { OnDisk = true };
            if (!_bytes.TryUpdate(key, claimed, memory)) return;
            var stored = false;
            try
            {
                stored = await _disk!.PutAsync(DiskNamespace, key, memory.Bytes, memory.ContentType, CancellationToken.None, memory.Generation, fetchedAt: memory.At).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // Optional: the image is still served from memory.
            }

            // Superseded (the generation moved on): it stays settled, never saved. Otherwise a later hit tries again.
            if (!stored && _disk!.Generation == memory.Generation) _bytes.TryUpdate(key, memory, claimed);
        }

        private static bool IsImageType(string type) => type is "image/jpeg" or "image/png" or "image/webp";

        /// <summary>Admitted image operations, including queued work (tests).</summary>
        internal int InFlightCount => _images.Count;

        private async Task<(byte[] Bytes, string ContentType)?> FetchUpstreamAsync(string key, string size, string path, long generation)
        {
            try
            {
                Interlocked.Increment(ref _upstreamFetches);
                using var timeout = new CancellationTokenSource(FetchTimeout);
                using var response = await TmdbTransport.GetAsync(_http, "https://image.tmdb.org/t/p/" + size + path, MetadataAdmission.Required, timeout.Token).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode) return null;
                var type = response.Content.Headers.ContentType?.MediaType ?? string.Empty;
                if (!IsImageType(type)) return null;
                if (response.Content.Headers.ContentLength > MaxImageBytes) return null;
                await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false);
                using var buffer = new System.IO.MemoryStream();
                var chunk = new byte[81920];
                int read;
                while ((read = await stream.ReadAsync(chunk, timeout.Token).ConfigureAwait(false)) > 0)
                {
                    if (buffer.Length + read > MaxImageBytes) return null;
                    buffer.Write(chunk, 0, read);
                }

                var bytes = buffer.ToArray();
                Store(key, bytes, type, onDisk: false, generation: generation);
                // Saved, or superseded by an invalidation since the fetch began: either way nothing is left to save.
                if (_disk != null && (await _disk.PutAsync(DiskNamespace, key, bytes, type, CancellationToken.None, generation).ConfigureAwait(false)
                        || _disk.Generation != generation)
                    && _bytes.TryGetValue(key, out var stored) && ReferenceEquals(stored.Bytes, bytes))
                {
                    _bytes.TryUpdate(key, stored with { OnDisk = true }, stored);
                }

                return (bytes, type);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private void Store(string key, byte[] bytes, string type, bool onDisk, long generation)
        {
            if (Interlocked.Add(ref _cachedBytes, bytes.Length) > MaxCacheBytes)
            {
                foreach (var old in _bytes.OrderBy(e => e.Value.At).ToList())
                {
                    if (_bytes.TryRemove(old.Key, out var removed)) Interlocked.Add(ref _cachedBytes, -removed.Bytes.Length);
                    if (Interlocked.Read(ref _cachedBytes) <= MaxCacheBytes / 2) break;
                }
            }

            if (_bytes.TryGetValue(key, out var previous)) Interlocked.Add(ref _cachedBytes, -previous.Bytes.Length);
            _bytes[key] = (bytes, type, DateTime.UtcNow, onDisk, generation);
        }

        private string Sign(byte[] payload)
            => Convert.ToHexStringLower(HMACSHA256.HashData(_key, payload)).Substring(0, HmacHexLength);
    }
}
#endif
