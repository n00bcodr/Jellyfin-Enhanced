using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>Whether people can still ask in Seerr: disabled, enabled, or unknown (the settings could not be read).</summary>
    /// <param name="State">disabled, enabled or unknown.</param>
    /// <param name="RequestingUsers">Non-admin Seerr users who still hold a request permission.</param>
    /// <param name="Admins">Seerr administrators (they can always ask in Seerr).</param>
    /// <param name="DefaultAllowsRequests">New Seerr users would get a request permission.</param>
    public sealed record SeerrRequestingState(string State, int RequestingUsers, int Admins, bool DefaultAllowsRequests);

    /// <summary>
    /// A complete-or-nothing read of every request Seerr holds, for the authority transfer. Separate from
    /// the capped background read model: it pages through the whole list from one address, and the read is
    /// complete only when Seerr's total stays the same on every page and on a final re-check, the ids come
    /// newest first with no repeats, as many arrive as Seerr reported, and every request Seerr changed since
    /// the read began is still as it was read. A change Seerr makes after that final check isn't seen; JE's own
    /// Seerr request writes are held off while a move runs (<see cref="SeerrRequestWriteFence"/>).
    /// </summary>
    /// <param name="Complete">Every request was read.</param>
    /// <param name="IncompleteReason">Why not (not_configured, unreachable, page_failed, total_changed, order_changed, row_changed, short_page, too_many).</param>
    /// <param name="Rows">Every request, newest first (empty when incomplete).</param>
    /// <param name="Unreadable">Ids of requests that could not be understood (counted, never imported).</param>
    /// <param name="Total">Seerr's reported total.</param>
    /// <param name="Digest">Digest of the complete set (empty when incomplete); any change in Seerr changes it.</param>
    /// <param name="AddressFingerprint">Hash of the normalised address set, without the API key.</param>
    /// <param name="Requesting">Whether people can still ask in Seerr.</param>
    public sealed record SeerrMigrationRead(bool Complete, string? IncompleteReason, IReadOnlyList<SeerrRequestRecord> Rows, IReadOnlyList<int> Unreadable,
        int Total, string Digest, string AddressFingerprint, SeerrRequestingState Requesting);

    /// <summary>Reads Seerr for the migration. Only GET requests; it never writes to Seerr.</summary>
    public sealed class SeerrMigrationReader
    {
        /// <summary>Requests per page.</summary>
        public const int PageSize = 100;

        /// <summary>Most requests a migration reads; a larger Seerr is refused as incomplete.</summary>
        public const int MaxRows = 50_000;

        private const JellyseerrPermission RequestBits = JellyseerrPermission.REQUEST | JellyseerrPermission.REQUEST_MOVIE | JellyseerrPermission.REQUEST_TV
            | JellyseerrPermission.REQUEST_4K | JellyseerrPermission.REQUEST_4K_MOVIE | JellyseerrPermission.REQUEST_4K_TV
            | JellyseerrPermission.AUTO_REQUEST | JellyseerrPermission.AUTO_REQUEST_MOVIE | JellyseerrPermission.AUTO_REQUEST_TV;

        private readonly IHttpClientFactory _http;

        /// <summary>Creates the reader.</summary>
        public SeerrMigrationReader(IHttpClientFactory http) { _http = http; }

        /// <summary>Most requests Seerr may change while one read runs; more is a busy Seerr, read again later.</summary>
        internal const int MaxChangedDuringRead = 1_000;

        /// <summary>Largest answer read from Seerr (a page of 100 requests is far smaller).</summary>
        internal const int MaxResponseBytes = 8 * 1024 * 1024;

        /// <summary>Per-call timeout.</summary>
        internal TimeSpan CallTimeout { get; set; } = TimeSpan.FromSeconds(15);

        /// <summary>Overall budget for one read.</summary>
        internal TimeSpan Budget { get; set; } = TimeSpan.FromMinutes(3);

        /// <summary>The configured addresses, trimmed, in order.</summary>
        internal static List<string> Urls(PluginConfiguration config)
            => (config.JellyseerrUrls ?? string.Empty).Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(u => u.Trim().TrimEnd('/')).Where(u => u.Length > 0).ToList();

        /// <summary>
        /// Fingerprint of the normalised, sorted address set (scheme and host lower case, no default port, no
        /// trailing slash). The API key is not part of it, so a key rotation keeps the same Seerr source.
        /// </summary>
        public static string AddressFingerprint(PluginConfiguration config)
        {
            var urls = Urls(config).Select(u => Uri.TryCreate(u, UriKind.Absolute, out var uri) ? uri.GetLeftPart(UriPartial.Path).TrimEnd('/') : u)
                .Distinct(StringComparer.Ordinal).OrderBy(u => u, StringComparer.Ordinal);
            return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("\n", urls))), 0, 12).ToLowerInvariant();
        }

        /// <summary>Reads every request and the requesting state from the first address that answers.</summary>
        /// <param name="config">The current configuration.</param>
        /// <param name="ct">Cancellation.</param>
        public Task<SeerrMigrationRead> ReadAsync(PluginConfiguration config, CancellationToken ct)
            => Backends.EffectiveRequestsBackend.Shared.ReadSeerrAsync(Backends.SeerrUse.RequestRead, _ => ReadCoreAsync(config, ct));

        private async Task<SeerrMigrationRead> ReadCoreAsync(PluginConfiguration config, CancellationToken ct)
        {
            var fingerprint = AddressFingerprint(config);
            var key = config.GetJellyseerrApiKey();
            var urls = Urls(config);
            var unknown = new SeerrRequestingState("unknown", 0, 0, false);
            if (urls.Count == 0 || string.IsNullOrEmpty(key)) return Incomplete("not_configured", 0, fingerprint, unknown);
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(Budget);
            var client = SeerrHttpHelper.CreateClient(_http);
            try
            {
                foreach (var url in urls)
                {
                    // The newest change before the pages are read: every request changed after it is checked
                    // against what the pages held once they are all read.
                    var mark = await Page(client, url, key, 0, 1, budget.Token, "modified").ConfigureAwait(false);
                    if (mark == null) continue;
                    DateTime? since = null;
                    if (mark.Value.Items.Count > 0 && (since = UpdatedAt(mark.Value.Items[0])) == null) return Incomplete("page_failed", 0, fingerprint, unknown);
                    var first = await Page(client, url, key, 0, PageSize, budget.Token).ConfigureAwait(false);
                    if (first == null) continue;
                    // Every later read comes from the address that answered first; never mixed.
                    var read = await ReadAll(client, url, key, first.Value, since, budget.Token).ConfigureAwait(false);
                    var requesting = await Requesting(client, url, key, budget.Token).ConfigureAwait(false);
                    return read with { AddressFingerprint = fingerprint, Requesting = requesting };
                }
                return Incomplete("unreachable", 0, fingerprint, unknown);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return Incomplete("page_failed", 0, fingerprint, unknown);
            }
        }

        private static SeerrMigrationRead Incomplete(string reason, int total, string fingerprint, SeerrRequestingState requesting)
            => new(false, reason, Array.Empty<SeerrRequestRecord>(), Array.Empty<int>(), total, string.Empty, fingerprint, requesting);

        private readonly record struct PageResult(int Total, List<JsonElement> Items);

        // When a request was last changed in Seerr (its updatedAt), or null when it doesn't say.
        private static DateTime? UpdatedAt(JsonElement item)
            => item.ValueKind == JsonValueKind.Object && item.TryGetProperty("updatedAt", out var value) && value.ValueKind == JsonValueKind.String &&
                DateTime.TryParse(value.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var at) ? at : null;

        private async Task<SeerrMigrationRead> ReadAll(HttpClient client, string url, string key, PageResult first, DateTime? since, CancellationToken ct)
        {
            var unknown = new SeerrRequestingState("unknown", 0, 0, false);
            var total = first.Total;
            if (total < 0) return Incomplete("page_failed", 0, string.Empty, unknown);
            if (total > MaxRows) return Incomplete("too_many", total, string.Empty, unknown);
            var rows = new List<SeerrRequestRecord>(Math.Min(total, MaxRows));
            var unreadable = new List<int>();
            var lines = new List<(int Id, string Line)>();
            var seen = new HashSet<int>();
            var lastId = int.MaxValue;
            var page = first;
            var skip = 0;
            while (true)
            {
                if (page.Total != total) return Incomplete("total_changed", total, string.Empty, unknown);
                if (page.Items.Count == 0) break;
                foreach (var item in page.Items)
                {
                    if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("id", out var idElement) || !idElement.TryGetInt32(out var id))
                        return Incomplete("page_failed", total, string.Empty, unknown);
                    if (id >= lastId || !seen.Add(id)) return Incomplete("order_changed", total, string.Empty, unknown);
                    lastId = id;
                    var record = SeerrRequestReadModel.Parse(item);
                    if (record == null) unreadable.Add(id);
                    else rows.Add(record);
                    lines.Add((id, Line(id, record)));
                }
                skip += page.Items.Count;
                if (skip >= total) break;
                if (page.Items.Count < PageSize) return Incomplete("short_page", total, string.Empty, unknown);
                var next = await Page(client, url, key, skip, PageSize, ct).ConfigureAwait(false);
                if (next == null) return Incomplete("page_failed", total, string.Empty, unknown);
                page = next.Value;
            }
            if (seen.Count != total) return Incomplete("short_page", total, string.Empty, unknown);
            // A final look at the newest request: a request added or removed while the pages were read changes it.
            var check = await Page(client, url, key, 0, 1, ct).ConfigureAwait(false);
            if (check == null) return Incomplete("page_failed", total, string.Empty, unknown);
            var newest = check.Value.Items.Count > 0 && check.Value.Items[0].TryGetProperty("id", out var newestId) && newestId.TryGetInt32(out var n) ? n : (int?)null;
            if (check.Value.Total != total || newest != (seen.Count == 0 ? null : seen.Max())) return Incomplete("total_changed", total, string.Empty, unknown);
            // A request already read that changed meanwhile (approved or declined in Seerr) leaves the total and
            // the newest id alone. Every request changed since the read began (newest change first, down to the
            // mark taken before the first page) must still be as its page held it.
            var byId = lines.ToDictionary(l => l.Id, l => l.Line);
            var compared = 0;
            for (var at = 0; ; at += PageSize)
            {
                var changed = await Page(client, url, key, at, PageSize, ct, "modified").ConfigureAwait(false);
                if (changed == null) return Incomplete("page_failed", total, string.Empty, unknown);
                if (changed.Value.Total != total) return Incomplete("total_changed", total, string.Empty, unknown);
                var older = false;
                foreach (var item in changed.Value.Items)
                {
                    if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("id", out var changedId) || !changedId.TryGetInt32(out var id))
                        return Incomplete("page_failed", total, string.Empty, unknown);
                    if (since != null && UpdatedAt(item) is DateTime updated && updated < since) { older = true; break; }
                    if (!byId.TryGetValue(id, out var line) || line != Line(id, SeerrRequestReadModel.Parse(item)) || ++compared > MaxChangedDuringRead)
                        return Incomplete("row_changed", total, string.Empty, unknown);
                }
                if (older || changed.Value.Items.Count < PageSize || at + PageSize >= total) break;
            }
            var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("\n", lines.OrderBy(l => l.Id).Select(l => l.Line))))).ToLowerInvariant();
            return new SeerrMigrationRead(true, null, rows, unreadable, total, digest, string.Empty, unknown);
        }

        // One request as the digest sees it: everything the import uses, so any change in Seerr changes the digest.
        private static string Line(int id, SeerrRequestRecord? r) => r == null
            ? id.ToString(CultureInfo.InvariantCulture) + "|unreadable"
            : string.Join("|", id.ToString(CultureInfo.InvariantCulture), r.IsMovie ? "movie" : "tv", r.TmdbId?.ToString(CultureInfo.InvariantCulture), r.TvdbId?.ToString(CultureInfo.InvariantCulture),
                r.Is4k ? "4k" : "standard", r.Status.ToString(CultureInfo.InvariantCulture), r.MediaStatus?.ToString(CultureInfo.InvariantCulture), string.Join(",", r.Seasons),
                r.RequestedBy?.ToString("N"), r.UpdatedAt?.ToString("O", CultureInfo.InvariantCulture));

        private async Task<PageResult?> Page(HttpClient client, string url, string key, int skip, int take, CancellationToken ct, string sort = "added")
        {
            var json = await Get(client, $"{url}/api/v1/request?take={take}&skip={skip}&sort={sort}&filter=all", key, ct).ConfigureAwait(false);
            if (json == null) return null;
            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("pageInfo", out var info) || info.ValueKind != JsonValueKind.Object ||
                    !info.TryGetProperty("results", out var totalElement) || !totalElement.TryGetInt32(out var total) ||
                    !root.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array) return null;
                return new PageResult(total, results.EnumerateArray().Select(e => e.Clone()).ToList());
            }
            catch (JsonException)
            {
                return null;
            }
        }

        // "disabled" needs complete proof: readable default permissions without a request bit and every user
        // read with none. Any proof that people can still ask (the defaults, or one non-admin user, seen before
        // a later read failed) is "enabled", which no confirmation overrides; without either it is "unknown".
        private async Task<SeerrRequestingState> Requesting(HttpClient client, string url, string key, CancellationToken ct)
        {
            bool? defaultAllows = null;
            var main = await Get(client, url + "/api/v1/settings/main", key, ct).ConfigureAwait(false);
            if (main != null)
            {
                try
                {
                    using var doc = JsonDocument.Parse(main);
                    if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("defaultPermissions", out var d) && d.TryGetInt64(out var bits))
                        defaultAllows = ((JellyseerrPermission)bits & RequestBits) != 0;
                }
                catch (JsonException)
                {
                    // Unreadable settings: no proof either way.
                }
            }
            var requesting = 0;
            var admins = 0;
            var usersComplete = await ReadUsers(client, url, key, ct, granted =>
            {
                if ((granted & JellyseerrPermission.ADMIN) != 0) admins++;
                else if ((granted & RequestBits) != 0) requesting++;
            }).ConfigureAwait(false);
            var allows = defaultAllows == true;
            if (allows || requesting > 0) return new SeerrRequestingState("enabled", requesting, admins, allows);
            return defaultAllows == false && usersComplete
                ? new SeerrRequestingState("disabled", 0, admins, false)
                : new SeerrRequestingState("unknown", 0, admins, false);
        }

        // Pages through every Seerr user, reporting each one's permissions; true only when all were read.
        private async Task<bool> ReadUsers(HttpClient client, string url, string key, CancellationToken ct, Action<JellyseerrPermission> seen)
        {
            var read = 0;
            int? total = null;
            for (var skip = 0; skip <= MaxRows; skip += PageSize)
            {
                var json = await Get(client, $"{url}/api/v1/user?take={PageSize}&skip={skip}", key, ct).ConfigureAwait(false);
                if (json == null) return false;
                try
                {
                    using var doc = JsonDocument.Parse(json);
                    if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("pageInfo", out var info) || info.ValueKind != JsonValueKind.Object ||
                        !info.TryGetProperty("results", out var t) || !t.TryGetInt32(out var pageTotal) ||
                        !doc.RootElement.TryGetProperty("results", out var users) || users.ValueKind != JsonValueKind.Array) return false;
                    if (total.HasValue && total != pageTotal) return false;
                    total = pageTotal;
                    var count = 0;
                    foreach (var user in users.EnumerateArray())
                    {
                        count++;
                        if (user.ValueKind != JsonValueKind.Object || !user.TryGetProperty("permissions", out var p) || !p.TryGetInt64(out var permissions)) return false;
                        seen((JellyseerrPermission)permissions);
                    }
                    read += count;
                    if (count == 0 || read >= total) break;
                }
                catch (JsonException)
                {
                    return false;
                }
            }
            return total != null && read >= total;
        }

        private async Task<string?> Get(HttpClient client, string requestUri, string key, CancellationToken ct)
        {
            using var call = CancellationTokenSource.CreateLinkedTokenSource(ct);
            call.CancelAfter(CallTimeout);
            try
            {
                using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, requestUri, key);
                // Headers first: the body is streamed with a hard limit instead of buffered whole, and a body
                // over the limit is a failed read (incomplete), never a truncated one.
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, call.Token).ConfigureAwait(false);
                if (response.Content.Headers.ContentLength > MaxResponseBytes) return null;
                var body = await ReadBoundedAsync(response.Content, call.Token).ConfigureAwait(false);
                if (body == null) return null;
                var copy = new ByteArrayContent(body);
                foreach (var header in response.Content.Headers) copy.Headers.TryAddWithoutValidation(header.Key, header.Value);
                response.Content.Dispose();
                response.Content = copy;
                var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, requestUri, call.Token).ConfigureAwait(false);
                return error == null ? json : null;
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return null;
            }
            catch (HttpRequestException)
            {
                return null;
            }
        }

        // The whole body, or null once it passes MaxResponseBytes (nothing past the limit is read).
        private static async Task<byte[]?> ReadBoundedAsync(HttpContent content, CancellationToken ct)
        {
            using var stream = await content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var buffer = new MemoryStream();
            var chunk = new byte[81920];
            int read;
            while ((read = await stream.ReadAsync(chunk.AsMemory(), ct).ConfigureAwait(false)) > 0)
            {
                if (buffer.Length + read > MaxResponseBytes) return null;
                buffer.Write(chunk, 0, read);
            }
            return buffer.ToArray();
        }
    }
}
