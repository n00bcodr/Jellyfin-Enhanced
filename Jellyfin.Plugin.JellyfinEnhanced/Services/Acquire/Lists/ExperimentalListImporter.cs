using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>The report of one importer run (administrators only).</summary>
    public sealed class ListImportReport
    {
        /// <summary>True when the run imported; false for a dry run (nothing written).</summary>
        [JsonPropertyName("applied")] public bool Applied { get; set; }

        /// <summary>When it ran (UTC ISO-8601).</summary>
        [JsonPropertyName("at")] public string At { get; set; } = string.Empty;

        /// <summary>Whether the experimental folder exists.</summary>
        [JsonPropertyName("sourceFound")] public bool SourceFound { get; set; }

        /// <summary>Top-level list documents found.</summary>
        [JsonPropertyName("documents")] public int Documents { get; set; }

        /// <summary>Collage marker documents found (<c>collages/</c>).</summary>
        [JsonPropertyName("collageMarkers")] public int CollageMarkers { get; set; }

        /// <summary>Lists imported (or, in a dry run, that would be).</summary>
        [JsonPropertyName("imported")] public List<ListImportEntry> Imported { get; set; } = new();

        /// <summary>Lists already imported from the same document (nothing to do).</summary>
        [JsonPropertyName("unchanged")] public List<ListImportEntry> Unchanged { get; set; } = new();

        /// <summary>Lists left out, with the reason (list_missing, kind_mismatch, exists).</summary>
        [JsonPropertyName("skipped")] public List<ListImportEntry> Skipped { get; set; } = new();

        /// <summary>Documents that can't be read as schema-1 lists (corrupt, unknown version), copied aside on import.</summary>
        [JsonPropertyName("quarantined")] public List<ListImportEntry> Quarantined { get; set; } = new();
    }

    /// <summary>One document of an importer report.</summary>
    public sealed class ListImportEntry
    {
        /// <summary>File name.</summary>
        [JsonPropertyName("file")] public string File { get; set; } = string.Empty;

        /// <summary>List id ("N"), when known.</summary>
        [JsonPropertyName("listId")] public string? ListId { get; set; }

        /// <summary>playlist or collection, when known.</summary>
        [JsonPropertyName("kind")] public string? Kind { get; set; }

        /// <summary>The list's current name in Jellyfin, when it exists.</summary>
        [JsonPropertyName("name")] public string? Name { get; set; }

        /// <summary>Entries in the document.</summary>
        [JsonPropertyName("entries")] public int Entries { get; set; }

        /// <summary>Pending swap intents (settled by real membership before anything new is inserted).</summary>
        [JsonPropertyName("intents")] public int Intents { get; set; }

        /// <summary>Whether the document has a linked source (kept, sync off until someone turns it on again).</summary>
        [JsonPropertyName("linkedSource")] public bool LinkedSource { get; set; }

        /// <summary>Whether a collage marker belongs to it.</summary>
        [JsonPropertyName("collageMarker")] public bool CollageMarker { get; set; }

        /// <summary>Why it was skipped or quarantined.</summary>
        [JsonPropertyName("reason")] public string? Reason { get; set; }
    }

    /// <summary>
    /// D33: a one-time, administrator-run compatibility importer for closed PR #936's experimental schema-1 list documents
    /// (<c>list-placeholders/&lt;listIdN&gt;.json</c> and <c>list-placeholders/collages/&lt;listIdN&gt;.json</c>).
    /// <list type="bullet">
    /// <item>The originals are only read: never moved, rewritten or deleted (a dry run writes nothing at all).</item>
    /// <item>Each document is validated (file name, schema 1, list id, kind, entries, ids); a corrupt or unknown one is
    /// quarantined (a copy under <c>lists/quarantine/</c>), never repaired in place.</item>
    /// <item>A list that no longer exists, or exists as the other kind, is skipped; one already in the new store is left
    /// alone (unchanged when it came from the same document, skipped otherwise). Running it again is safe.</item>
    /// <item>What is preserved: list and entry ids, real-entry order, expected/filled episodes, intent occurrence counts,
    /// the linked source (provider, generation, last complete snapshot, ownership, tombstones). Entries are the standard
    /// edition (#936 lists asked for standard copies only). The old in-memory replay cache isn't imported.</item>
    /// <item>Everything that acts stays off: swap-in has no consent, linked sync is off and paused for review, and the list
    /// waits for reconciliation (pending intents are settled by Jellyfin's real membership before anything new goes in).
    /// No request is made or re-sent from an old placeholder.</item>
    /// <item>Collage markers are copied to <c>lists/legacy-collages/</c> so the collage feature can tell an image JE made
    /// from a user's image.</item>
    /// </list>
    /// </summary>
    public sealed class ExperimentalListImporter
    {
        /// <summary>The experimental folder's name (in Jellyfin Enhanced's data folder).</summary>
        public const string SourceFolderName = "list-placeholders";

        /// <summary>Most documents one run reads.</summary>
        public const int MaxDocuments = 5000;

        /// <summary>Largest document read (bytes).</summary>
        public const long MaxDocumentBytes = 32L * 1024 * 1024;

        private static readonly JsonSerializerOptions ReadJson = new() { ReadCommentHandling = JsonCommentHandling.Disallow, AllowTrailingCommas = false };
        private static readonly JsonSerializerOptions ReportJson = new() { WriteIndented = true };

        private readonly string _sourceDir;
        private readonly ListStore _store;
        private readonly IListHost _host;
        private readonly IUserManager? _userManager;
        private readonly ListSwapService? _swap;
        private readonly Logger _logger;
        private readonly SemaphoreSlim _gate = new(1, 1);

        /// <summary>Creates the importer (DI).</summary>
        /// <param name="appPaths">Application paths.</param>
        /// <param name="store">The list store.</param>
        /// <param name="host">Jellyfin seam (list existence and kind).</param>
        /// <param name="userManager">Users (owner check).</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="swap">Swap service (reconciliation passes after an import).</param>
        public ExperimentalListImporter(IApplicationPaths appPaths, ListStore store, IListHost host, IUserManager userManager, Logger logger, ListSwapService? swap = null)
            : this(Path.Combine(appPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", SourceFolderName), store, host, userManager, logger, swap)
        {
        }

        /// <summary>Creates the importer over a source folder (tests).</summary>
        /// <param name="sourceDir">The experimental folder.</param>
        /// <param name="store">The list store.</param>
        /// <param name="host">Jellyfin seam.</param>
        /// <param name="userManager">Users, or null.</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="swap">Swap service, or null.</param>
        internal ExperimentalListImporter(string sourceDir, ListStore store, IListHost host, IUserManager? userManager, Logger logger, ListSwapService? swap = null)
        {
            _sourceDir = sourceDir;
            _store = store;
            _host = host;
            _userManager = userManager;
            _logger = logger;
            _swap = swap;
        }

        /// <summary>Clock (tests).</summary>
        internal Func<DateTime> UtcNow { get; set; } = () => DateTime.UtcNow;

        /// <summary>Runs the importer: a dry run (<paramref name="apply"/> false) reads only; an import writes new documents.</summary>
        /// <param name="apply">Import (true) or report only (false).</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The report.</returns>
        public async Task<ListImportReport> RunAsync(bool apply, CancellationToken cancellationToken)
        {
            await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                var report = await RunCoreAsync(apply, cancellationToken).ConfigureAwait(false);
                if (apply)
                {
                    WriteReport(report);
                    _logger.Info($"[Lists] Experimental-list import: {report.Imported.Count} imported, {report.Unchanged.Count} already imported, {report.Skipped.Count} skipped, {report.Quarantined.Count} quarantined.");
                    foreach (var entry in report.Imported)
                    {
                        _swap?.QueuePass(entry.ListId!, Array.Empty<string>(), MetadataMode.None);
                    }
                }

                return report;
            }
            finally
            {
                _gate.Release();
            }
        }

        private async Task<ListImportReport> RunCoreAsync(bool apply, CancellationToken cancellationToken)
        {
            var now = UtcNow();
            var report = new ListImportReport { Applied = apply, At = now.ToString("o", CultureInfo.InvariantCulture), SourceFound = Directory.Exists(_sourceDir) };
            if (!report.SourceFound)
            {
                return report;
            }

            var collageDir = Path.Combine(_sourceDir, "collages");
            var collages = Directory.Exists(collageDir)
                ? Directory.EnumerateFiles(collageDir, "*.json", SearchOption.TopDirectoryOnly).Select(Path.GetFileNameWithoutExtension).OfType<string>().Where(ListStore.IsValidListId).ToHashSet(StringComparer.Ordinal)
                : new HashSet<string>(StringComparer.Ordinal);
            report.CollageMarkers = collages.Count;

            var files = Directory.EnumerateFiles(_sourceDir, "*.json", SearchOption.TopDirectoryOnly).OrderBy(f => f, StringComparer.Ordinal).Take(MaxDocuments).ToList();
            report.Documents = files.Count;
            foreach (var file in files)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var name = Path.GetFileName(file);
                byte[] bytes;
                try
                {
                    var info = new FileInfo(file);
                    if (info.Length > MaxDocumentBytes)
                    {
                        Quarantine(report, file, name, null, "too_large", apply);
                        continue;
                    }

                    bytes = await File.ReadAllBytesAsync(file, cancellationToken).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    report.Skipped.Add(new ListImportEntry { File = name, Reason = "unreadable" });
                    _logger.Warning($"[Lists] Import: {name} could not be read ({ex.Message}); it is left as it is.");
                    continue;
                }

                var listIdN = Path.GetFileNameWithoutExtension(file);
                var (doc, invalid) = Parse(bytes, listIdN);
                if (doc == null)
                {
                    Quarantine(report, file, name, ListStore.IsValidListId(listIdN) ? listIdN : null, invalid ?? "invalid", apply);
                    continue;
                }

                var entry = new ListImportEntry
                {
                    File = name,
                    ListId = listIdN,
                    Kind = doc.ListKind,
                    Entries = doc.Items.Count,
                    Intents = doc.Intents.Count,
                    LinkedSource = doc.Source != null,
                    CollageMarker = collages.Contains(listIdN),
                };

                var list = _host.GetList(Guid.ParseExact(listIdN, "N"));
                if (list == null)
                {
                    entry.Reason = "list_missing";
                    report.Skipped.Add(entry);
                    continue;
                }

                entry.Name = list.Name;
                if (list.Kind != doc.ListKind)
                {
                    entry.Reason = "kind_mismatch";
                    report.Skipped.Add(entry);
                    continue;
                }

                if (list.Kind == ListKinds.Playlist && _userManager != null && (list.OwnerId == Guid.Empty || _userManager.GetUserById(list.OwnerId) == null))
                {
                    // Kept: Jellyfin keeps an open-access playlist whose owner is gone; nothing can be added as its owner.
                    entry.Reason = "owner_missing";
                }

                var sha = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
                ListDoc? existing;
                try
                {
                    existing = _store.Load(listIdN);
                }
                catch (InvalidDataException)
                {
                    entry.Reason = "exists_unreadable";
                    report.Skipped.Add(entry);
                    continue;
                }

                if (existing != null)
                {
                    if (existing.ImportedFrom?.Sha256 == sha)
                    {
                        report.Unchanged.Add(entry);
                    }
                    else
                    {
                        entry.Reason = "exists";
                        report.Skipped.Add(entry);
                    }

                    continue;
                }

                if (apply)
                {
                    using (await _store.LockAsync(listIdN, cancellationToken).ConfigureAwait(false))
                    {
                        if (_store.Load(listIdN) != null)
                        {
                            entry.Reason = "exists";
                            report.Skipped.Add(entry);
                            continue;
                        }

                        _store.Save(ToSchema2(doc, sha, now));
                        if (entry.CollageMarker)
                        {
                            CopyCollageMarker(Path.Combine(collageDir, listIdN + ".json"), listIdN);
                        }
                    }
                }

                report.Imported.Add(entry);
            }

            return report;
        }

        /// <summary>Reads a schema-1 document strictly; null with a reason when it isn't one.</summary>
        /// <param name="bytes">File bytes.</param>
        /// <param name="listIdN">The id the file name gives.</param>
        /// <returns>The document (as read) or the reason.</returns>
        internal static (ListDoc? Doc, string? Reason) Parse(byte[] bytes, string listIdN)
        {
            if (!ListStore.IsValidListId(listIdN))
            {
                return (null, "bad_file_name");
            }

            ListDoc? doc;
            try
            {
                using (var json = JsonDocument.Parse(bytes))
                {
                    if (json.RootElement.ValueKind != JsonValueKind.Object
                        || !json.RootElement.TryGetProperty("schema", out var schema) || schema.ValueKind != JsonValueKind.Number || !schema.TryGetInt32(out var version))
                    {
                        return (null, "no_schema");
                    }

                    if (version != 1)
                    {
                        return (null, "unknown_schema");
                    }
                }

                doc = JsonSerializer.Deserialize<ListDoc>(bytes, ReadJson);
            }
            catch (JsonException)
            {
                return (null, "corrupt");
            }

            if (doc == null || doc.ListId != listIdN)
            {
                return (null, "list_id_mismatch");
            }

            if (doc.ListKind is not (ListKinds.Playlist or ListKinds.Collection))
            {
                return (null, "unknown_kind");
            }

            if (doc.Items == null || doc.Order == null || doc.Intents == null || doc.Items.Any(i => i == null || !IsId(i.Id))
                || doc.Items.Select(i => i.Id).Distinct(StringComparer.Ordinal).Count() != doc.Items.Count || doc.Items.Count > ListStore.MaxPlaceholders)
            {
                return (null, "bad_entries");
            }

            foreach (var item in doc.Items)
            {
                item.Episodes ??= new List<PlaceholderEpisode>();
                item.Expected ??= new List<PlaceholderEpisode>();
                item.Filled ??= new List<FilledEpisode>();
                if (!ValidEntry(item))
                {
                    return (null, "bad_entry");
                }
            }

            if (doc.Intents.Any(i => i == null || !IsId(i.PhId) || i.ItemIds == null || i.ItemIds.Any(id => !IsId(id))))
            {
                return (null, "bad_intents");
            }

            return (doc, null);
        }

        // The schema-2 document of an imported list: everything that acts off, intents kept for reconciliation.
        private static ListDoc ToSchema2(ListDoc source, string sha, DateTime now)
        {
            var doc = ListStore.Clone(source);
            var rev = doc.Rev;
            doc.Schema = ListDoc.CurrentSchema;
            doc.SwapIn = null;
            doc.Reconcile = "import";
            doc.ImportedFrom = new ListImportProvenance { Schema = 1, Rev = rev, Sha256 = sha, At = now.ToString("o", CultureInfo.InvariantCulture) };
            doc.Order = doc.Order.Where(t => ListOrder.IsReal(t) || ListOrder.IsPlaceholder(t)).ToList();
            foreach (var item in doc.Items)
            {
                item.Edition = null; // standard: #936 asked for standard copies only
            }

            if (doc.Source != null)
            {
                // The link and its provenance stay; nothing syncs until a current editor turns it on again.
                doc.Source.SyncEnabled = false;
                doc.Source.RemoveDropped = false;
                doc.Source.PausedCode = "imported";
                doc.Source.PausedReason = "Imported from the experimental lists: check the link and turn sync on again.";
            }

            return doc;
        }

        private static bool ValidEntry(Placeholder item)
        {
            if (!PlaceholderKinds.IsKnown(item.Kind) || string.IsNullOrWhiteSpace(item.Title) || item.Title.Length > ListRules.MaxTitle * 2)
            {
                return false;
            }

            if (item.MediaType is not ("movie" or "tv"))
            {
                return false;
            }

            if (item.Kind != PlaceholderKinds.Custom && item.TmdbId is not > 0)
            {
                return false;
            }

            if (item.Kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes && item.SeasonNumber is not (>= 0 and <= 200))
            {
                return false;
            }

            // Every episode record is there and readable (progress and views count them): coordinates in range, an episodes
            // entry's episodes in its season, air dates as the list writes them.
            return item.Episodes.Count <= ListRules.MaxEpisodes && item.Expected.Count <= PlaceholderProgress.MaxExpected
                && item.Episodes.All(e => ValidEpisode(e) && (item.Kind != PlaceholderKinds.Episodes || e.S == item.SeasonNumber))
                && item.Expected.All(ValidEpisode)
                && item.Filled.All(f => f != null && IsId(f.ItemId) && ValidCoordinates(f.S, f.E) && (f.Via == null || IsId(f.Via)));
        }

        private static bool ValidEpisode(PlaceholderEpisode? episode) =>
            episode != null && ValidCoordinates(episode.S, episode.E)
            && (string.IsNullOrWhiteSpace(episode.AirDate) || ListRules.TryParseDate(episode.AirDate.Trim(), out _));

        // Wide bounds: daily shows can number seasons by year and episodes into the thousands.
        private static bool ValidCoordinates(int season, int episode) => season is >= 0 and <= 99999 && episode is >= 0 and <= 99999;

        private static bool IsId(string? id) => id != null && id.Length == 32 && Guid.TryParseExact(id, "N", out _);

        private void Quarantine(ListImportReport report, string file, string name, string? listIdN, string reason, bool apply)
        {
            report.Quarantined.Add(new ListImportEntry { File = name, ListId = listIdN, Reason = reason });
            if (!apply)
            {
                return;
            }

            try
            {
                var dir = Path.Combine(_store.DirectoryPath, "quarantine");
                Directory.CreateDirectory(dir);
                var target = Path.Combine(dir, name + "." + UtcNow().ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture));
                if (!File.Exists(target))
                {
                    File.Copy(file, target);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.Warning($"[Lists] Import: could not copy {name} to quarantine ({ex.Message}); the original is left as it is.");
            }
        }

        private void CopyCollageMarker(string source, string listIdN)
        {
            try
            {
                var dir = Path.Combine(_store.DirectoryPath, "legacy-collages");
                Directory.CreateDirectory(dir);
                var target = Path.Combine(dir, listIdN + ".json");
                if (!File.Exists(target))
                {
                    File.Copy(source, target);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.Warning($"[Lists] Import: could not copy the collage marker of {listIdN} ({ex.Message}).");
            }
        }

        private void WriteReport(ListImportReport report)
        {
            try
            {
                var dir = Path.Combine(_store.DirectoryPath, "import-reports");
                Directory.CreateDirectory(dir);
                File.WriteAllText(Path.Combine(dir, "import-" + UtcNow().ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture) + ".json"), JsonSerializer.Serialize(report, ReportJson));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.Warning($"[Lists] Import: could not save the report ({ex.Message}).");
            }
        }
    }
}
