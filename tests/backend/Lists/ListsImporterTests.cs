using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// D33: the one-time importer of closed PR #936's schema-1 list documents. A dry run writes nothing; an import writes
// schema-2 documents with everything that acts turned off; bad documents are quarantined as copies; originals are never
// touched; running it again is safe.
[Collection("Plugin singleton")]
public class ListsImporterTests
{
    private static readonly CancellationToken None = CancellationToken.None;
    private static readonly DateTime Stamp = new(2026, 10, 17, 9, 30, 15, DateTimeKind.Utc);
    private static readonly DateTime OldTime = new(2025, 6, 1, 0, 0, 0, DateTimeKind.Utc);
    private const string StampText = "20261017093015";

    private sealed class Rig : IDisposable
    {
        public ListsHarness H { get; } = new();
        public User Owner { get; }
        public string Source { get; }
        public ExperimentalListImporter Importer { get; }

        public Rig()
        {
            Owner = H.NewUser("owner");
            Source = Path.Combine(H.Plugin.Core.ConfigRoot, ExperimentalListImporter.SourceFolderName);
            Directory.CreateDirectory(Source);
            Importer = new ExperimentalListImporter(Source, H.Store, H.Host, H.Users.Object, H.Plugin.Core.Logger) { UtcNow = () => Stamp };
        }

        public string StoreDir => H.Store.DirectoryPath;

        public string Write(string fileName, string json, bool collage = false)
        {
            var dir = collage ? Path.Combine(Source, "collages") : Source;
            Directory.CreateDirectory(dir);
            var path = Path.Combine(dir, fileName);
            File.WriteAllText(path, json);
            File.SetLastWriteTimeUtc(path, OldTime);
            return path;
        }

        public void Dispose() => H.Dispose();
    }

    private sealed record Ids(string List, string Owner, string Movie, string Season, string Episode, string Real);

    private static Ids NewIds(Guid list, User owner) => new(list.ToString("N"), owner.Id.ToString("N"), N(), N(), N(), N());

    private static string N() => Guid.NewGuid().ToString("N");

    // A #936 document: a movie (asked for in 4K, which #936 never did), a season with a filled episode and a pending
    // intent, a real entry, an unknown order token, a linked source with snapshot/ownership/tombstones, and a consent.
    private static string SchemaOne(Ids ids, string kind = "playlist", int schema = 1, string? listIdInDoc = null) => $$"""
        {
          "schema": {{schema}},
          "listId": "{{listIdInDoc ?? ids.List}}",
          "listKind": "{{kind}}",
          "rev": 7,
          "order": ["{{E(Guid.ParseExact(ids.Real, "N"))}}", "p:{{ids.Movie}}", "p:{{ids.Season}}", "x:not-a-token"],
          "items": [
            { "id": "{{ids.Movie}}", "kind": "movie", "mediaType": "movie", "tmdbId": 603, "title": "The Matrix", "releaseDate": "1999-03-31",
              "edition": "4k", "addedBy": "{{ids.Owner}}", "addedAt": "2025-01-01T00:00:00Z", "sourceKey": "tmdb:movie:603" },
            { "id": "{{ids.Season}}", "kind": "season", "mediaType": "tv", "tmdbId": 1399, "seasonNumber": 1, "title": "Show S1",
              "expected": [ { "s": 1, "e": 1 }, { "s": 1, "e": 2 } ], "filled": [ { "itemId": "{{ids.Episode}}", "s": 1, "e": 1 } ],
              "addedBy": "{{ids.Owner}}", "addedAt": "2025-01-01T00:00:00Z" }
          ],
          "source": { "kind": "mdblist", "provider": "mdblist", "url": "https://mdblist.com/lists/someone/list", "syncEnabled": true, "removeDropped": true,
            "linkedByUserId": "{{ids.Owner}}", "generation": 4, "lastSnapshotKeys": ["tmdb:movie:603", "tmdb:tv:1399"],
            "owned": { "tmdb:movie:603": { "phId": "{{ids.Movie}}", "itemIds": [] } }, "userRemovedKeys": { "tmdb:movie:1": "2025-01-01T00:00:00Z" } },
          "intents": [ { "phId": "{{ids.Season}}", "itemIds": ["{{ids.Episode}}"], "anchor": "p:{{ids.Season}}", "index": 1,
            "occurrenceCountsBefore": { "{{ids.Episode}}": 0 }, "createdAt": "2025-01-01T00:00:00Z" } ],
          "swapIn": { "byUserId": "{{ids.Owner}}", "at": "2025-01-01T00:00:00Z" },
          "updatedAt": "2025-01-02T00:00:00Z"
        }
        """;

    private static Dictionary<string, (string Sha, DateTime Mtime)> Snapshot(string root) =>
        !Directory.Exists(root) ? new() : Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .ToDictionary(f => Path.GetRelativePath(root, f), f => (Sha(File.ReadAllBytes(f)), File.GetLastWriteTimeUtc(f)), StringComparer.Ordinal);

    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static void AssertSame(Dictionary<string, (string Sha, DateTime Mtime)> before, Dictionary<string, (string Sha, DateTime Mtime)> after) =>
        Assert.Equal(before.OrderBy(p => p.Key, StringComparer.Ordinal).ToList(), after.OrderBy(p => p.Key, StringComparer.Ordinal).ToList());

    private static List<string> FilesUnder(string dir) =>
        !Directory.Exists(dir) ? new() : Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories).Select(f => Path.GetRelativePath(dir, f)).OrderBy(f => f, StringComparer.Ordinal).ToList();

    [Fact]
    public async Task ADryRunReportsWhatWouldHappenAndWritesNothingAtAll()
    {
        using var r = new Rig();
        var list = r.H.Host.AddPlaylist(r.Owner);
        var ids = NewIds(list.Info.Id, r.Owner);
        r.Write(ids.List + ".json", SchemaOne(ids));
        r.Write(ids.List + ".json", "{\"marker\":true}", collage: true);
        r.Write(N() + ".json", "{ not json");
        var before = Snapshot(r.H.Plugin.Core.ConfigRoot);

        var report = await r.Importer.RunAsync(apply: false, None);

        Assert.False(report.Applied);
        Assert.True(report.SourceFound);
        Assert.Equal((2, 1), (report.Documents, report.CollageMarkers));
        var entry = Assert.Single(report.Imported);
        Assert.Equal((ids.List, "playlist", "Playlist", 2, 1, true, true), (entry.ListId, entry.Kind, entry.Name, entry.Entries, entry.Intents, entry.LinkedSource, entry.CollageMarker));
        Assert.Equal("corrupt", Assert.Single(report.Quarantined).Reason);
        Assert.Equal(Stamp.ToString("o", CultureInfo.InvariantCulture), report.At);

        AssertSame(before, Snapshot(r.H.Plugin.Core.ConfigRoot));
        Assert.Empty(FilesUnder(r.StoreDir));
        Assert.Null(r.H.Store.Load(ids.List));
    }

    [Fact]
    public async Task AnImportWritesASchemaTwoDocumentThatKeepsTheListAndTurnsEverythingThatActsOff()
    {
        using var r = new Rig();
        var list = r.H.Host.AddPlaylist(r.Owner);
        var ids = NewIds(list.Info.Id, r.Owner);
        var path = r.Write(ids.List + ".json", SchemaOne(ids));
        var originals = Snapshot(r.Source);
        var sha = Sha(File.ReadAllBytes(path));

        var report = await r.Importer.RunAsync(apply: true, None);

        Assert.True(report.Applied);
        Assert.Equal(ids.List, Assert.Single(report.Imported).ListId);
        AssertSame(originals, Snapshot(r.Source));
        var json = JsonDocument.Parse(File.ReadAllText(Path.Combine(r.StoreDir, ids.List + ".json"))).RootElement;
        Assert.Equal(ListDoc.CurrentSchema, json.GetProperty("schema").GetInt32());

        var doc = r.H.Store.Load(ids.List)!;
        Assert.Equal((ids.List, ListKinds.Playlist), (doc.ListId, doc.ListKind));
        // Ids, order (unknown tokens dropped), expected/filled, intents.
        Assert.Equal(new[] { E(Guid.ParseExact(ids.Real, "N")), "p:" + ids.Movie, "p:" + ids.Season }, doc.Order);
        Assert.Equal(new[] { ids.Movie, ids.Season }, doc.Items.Select(p => p.Id));
        var movie = doc.Items[0];
        Assert.Equal((603, "The Matrix", "1999-03-31", ids.Owner, "tmdb:movie:603"), (movie.TmdbId!.Value, movie.Title, movie.ReleaseDate, movie.AddedBy, movie.SourceKey));
        Assert.Null(movie.Edition); // #936 asked for standard copies only
        Assert.Equal(ListRules.Standard, ListRules.EditionOf(movie));
        var season = doc.Items[1];
        Assert.Equal(new[] { (1, 1), (1, 2) }, season.Expected.Select(e => (e.S, e.E)));
        Assert.Equal(new[] { (ids.Episode, 1, 1) }, season.Filled.Select(f => (f.ItemId, f.S, f.E)));
        var intent = Assert.Single(doc.Intents);
        Assert.Equal((ids.Season, ids.Episode, "p:" + ids.Season, (int?)1, 0), (intent.PhId, string.Join(",", intent.ItemIds), intent.Anchor, intent.Index, intent.OccurrenceCountsBefore[ids.Episode]));
        // The linked source: provenance kept, sync off and paused for review.
        var source = doc.Source!;
        Assert.Equal(("mdblist", 4, ids.Owner), (source.Provider, source.Generation, source.LinkedByUserId));
        Assert.Equal(new[] { "tmdb:movie:603", "tmdb:tv:1399" }, source.LastSnapshotKeys);
        Assert.Equal(ids.Movie, source.Owned["tmdb:movie:603"].PhId);
        Assert.Equal("2025-01-01T00:00:00Z", source.UserRemovedKeys["tmdb:movie:1"]);
        Assert.Equal((false, false, "imported"), (source.SyncEnabled, source.RemoveDropped, source.PausedCode));
        Assert.False(string.IsNullOrEmpty(source.PausedReason));
        // No consent, waiting for reconciliation, and where it came from.
        Assert.Null(doc.SwapIn);
        Assert.Equal("import", doc.Reconcile);
        Assert.Equal((1, 7, sha, Stamp.ToString("o", CultureInfo.InvariantCulture)), (doc.ImportedFrom!.Schema, doc.ImportedFrom.Rev, doc.ImportedFrom.Sha256, doc.ImportedFrom.At));
    }

    [Fact]
    public async Task DocumentsThatArentSchemaOneListsAreQuarantinedAsCopiesOnImportOnly()
    {
        using var r = new Rig();
        var list = r.H.Host.AddPlaylist(r.Owner);
        var ids = NewIds(list.Info.Id, r.Owner);
        var corrupt = N();
        var schemaThree = N();
        var noSchema = N();
        var mismatch = N();
        var badEntry = N();
        r.Write(corrupt + ".json", "{\"schema\":1,");
        r.Write(schemaThree + ".json", SchemaOne(ids with { List = schemaThree }, schema: 3));
        r.Write(noSchema + ".json", SchemaOne(ids with { List = noSchema }).Replace("\"schema\": 1,", string.Empty, StringComparison.Ordinal));
        r.Write(mismatch + ".json", SchemaOne(ids with { List = mismatch }, listIdInDoc: ids.List));
        r.Write(badEntry + ".json", SchemaOne(ids with { List = badEntry }).Replace("\"tmdbId\": 603", "\"tmdbId\": 0", StringComparison.Ordinal));
        r.Write("not-a-list-id.json", SchemaOne(ids));
        var originals = Snapshot(r.Source);
        var expected = new Dictionary<string, string>
        {
            [corrupt + ".json"] = "corrupt",
            [schemaThree + ".json"] = "unknown_schema",
            [noSchema + ".json"] = "no_schema",
            [mismatch + ".json"] = "list_id_mismatch",
            [badEntry + ".json"] = "bad_entry",
            ["not-a-list-id.json"] = "bad_file_name",
        };

        var dry = await r.Importer.RunAsync(apply: false, None);
        Assert.Equal(expected.OrderBy(p => p.Key, StringComparer.Ordinal), dry.Quarantined.Select(q => KeyValuePair.Create(q.File, q.Reason!)).OrderBy(p => p.Key, StringComparer.Ordinal));
        Assert.Null(dry.Quarantined.Single(q => q.File == "not-a-list-id.json").ListId);
        Assert.Empty(dry.Imported);
        Assert.Empty(FilesUnder(r.StoreDir));

        var applied = await r.Importer.RunAsync(apply: true, None);
        Assert.Equal(expected.Count, applied.Quarantined.Count);
        Assert.Empty(applied.Imported);
        Assert.Empty(r.H.Store.EnumerateListIds());
        var quarantine = Path.Combine(r.StoreDir, "quarantine");
        Assert.Equal(expected.Keys.Select(f => f + "." + StampText).OrderBy(f => f, StringComparer.Ordinal), FilesUnder(quarantine));
        foreach (var file in expected.Keys)
        {
            Assert.Equal(File.ReadAllBytes(Path.Combine(r.Source, file)), File.ReadAllBytes(Path.Combine(quarantine, file + "." + StampText)));
        }

        AssertSame(originals, Snapshot(r.Source));
    }

    [Fact]
    public async Task MissingListsTheOtherKindAndDifferentExistingDocumentsAreSkippedAndASecondRunIsUnchanged()
    {
        using var r = new Rig();
        var imported = r.H.Host.AddPlaylist(r.Owner);
        var wrongKind = r.H.Host.AddCollection();
        var taken = r.H.Host.AddPlaylist(r.Owner);
        var good = NewIds(imported.Info.Id, r.Owner);
        var missing = NewIds(Guid.NewGuid(), r.Owner);
        var kind = NewIds(wrongKind.Info.Id, r.Owner);
        var exists = NewIds(taken.Info.Id, r.Owner);
        r.Write(good.List + ".json", SchemaOne(good));
        r.Write(missing.List + ".json", SchemaOne(missing));
        r.Write(kind.List + ".json", SchemaOne(kind, kind: "playlist"));
        r.Write(exists.List + ".json", SchemaOne(exists));
        using (await r.H.Store.LockAsync(exists.List))
        {
            var doc = r.H.Store.LoadForUpdate(exists.List, ListKinds.Playlist);
            doc.Items.Add(Movie(1));
            r.H.Store.Save(doc);
        }

        var takenBefore = File.ReadAllBytes(Path.Combine(r.StoreDir, exists.List + ".json"));
        var originals = Snapshot(r.Source);

        var first = await r.Importer.RunAsync(apply: true, None);

        Assert.Equal(new[] { good.List }, first.Imported.Select(e => e.ListId));
        var skipped = first.Skipped.ToDictionary(e => e.ListId!, e => e.Reason);
        Assert.Equal(3, skipped.Count);
        Assert.Equal(("list_missing", "kind_mismatch", "exists"), (skipped[missing.List], skipped[kind.List], skipped[exists.List]));
        Assert.Null(r.H.Store.Load(missing.List));
        Assert.Null(r.H.Store.Load(kind.List));
        Assert.Equal(takenBefore, File.ReadAllBytes(Path.Combine(r.StoreDir, exists.List + ".json")));

        var storeAfterFirst = Snapshot(Path.Combine(r.StoreDir));
        var rev = r.H.Store.Load(good.List)!.Rev;
        var second = await r.Importer.RunAsync(apply: true, None);

        Assert.Empty(second.Imported);
        Assert.Equal(new[] { good.List }, second.Unchanged.Select(e => e.ListId));
        Assert.Equal(3, second.Skipped.Count);
        Assert.Equal(rev, r.H.Store.Load(good.List)!.Rev);
        // Only the report (same file name: same clock) may be rewritten; every list document is as it was.
        var storeAfterSecond = Snapshot(r.StoreDir);
        AssertSame(
            storeAfterFirst.Where(p => !p.Key.StartsWith("import-reports", StringComparison.Ordinal)).ToDictionary(p => p.Key, p => p.Value),
            storeAfterSecond.Where(p => !p.Key.StartsWith("import-reports", StringComparison.Ordinal)).ToDictionary(p => p.Key, p => p.Value));
        AssertSame(originals, Snapshot(r.Source));
    }

    [Fact]
    public async Task AnImportCopiesTheCollageMarkerAndSavesAReportWhichADryRunNeverDoes()
    {
        using var r = new Rig();
        var list = r.H.Host.AddPlaylist(r.Owner);
        var ids = NewIds(list.Info.Id, r.Owner);
        r.Write(ids.List + ".json", SchemaOne(ids));
        var marker = r.Write(ids.List + ".json", "{\"generatedBy\":\"je\",\"hash\":\"abc\"}", collage: true);
        var legacy = Path.Combine(r.StoreDir, "legacy-collages", ids.List + ".json");
        var reports = Path.Combine(r.StoreDir, "import-reports");

        await r.Importer.RunAsync(apply: false, None);
        Assert.False(File.Exists(legacy));
        Assert.False(Directory.Exists(reports));

        var report = await r.Importer.RunAsync(apply: true, None);

        Assert.True(Assert.Single(report.Imported).CollageMarker);
        Assert.Equal(File.ReadAllBytes(marker), File.ReadAllBytes(legacy));
        Assert.Equal(OldTime, File.GetLastWriteTimeUtc(marker));
        var saved = Path.Combine(reports, "import-" + StampText + ".json");
        Assert.Equal(new[] { Path.GetFileName(saved) }, Directory.GetFiles(reports).Select(Path.GetFileName));
        var json = JsonDocument.Parse(File.ReadAllText(saved)).RootElement;
        Assert.True(json.GetProperty("applied").GetBoolean());
        Assert.Equal(ids.List, json.GetProperty("imported")[0].GetProperty("listId").GetString());
    }

    [Fact]
    public async Task TheStoreHasNoDefaultSchemaSoAnOtherwiseValidDocumentWithoutOneIsRefusedAndASaveWritesSchemaTwo()
    {
        using var r = new Rig();
        var list = r.H.Host.AddPlaylist(r.Owner);
        var id = list.Info.Id.ToString("N");
        Directory.CreateDirectory(r.StoreDir);
        var path = Path.Combine(r.StoreDir, id + ".json");
        var content = "{\"listId\":\"" + id + "\",\"listKind\":\"playlist\",\"rev\":3,\"order\":[],\"items\":[],\"intents\":[]}";
        File.WriteAllText(path, content);

        Assert.Throws<InvalidDataException>(() => r.H.Store.Load(id));
        Assert.Equal(content, File.ReadAllText(path));

        // The same document with the current schema reads; saving it writes the schema explicitly.
        File.WriteAllText(path, content.Replace("{\"listId\"", "{\"schema\":2,\"listId\"", StringComparison.Ordinal));
        r.H.Store.InvalidateAll();
        using (await r.H.Store.LockAsync(id))
        {
            var doc = r.H.Store.LoadForUpdate(id, ListKinds.Playlist);
            doc.Schema = 0;
            r.H.Store.Save(doc);
        }

        Assert.Equal(ListDoc.CurrentSchema, JsonDocument.Parse(File.ReadAllText(path)).RootElement.GetProperty("schema").GetInt32());
        Assert.Equal(4, r.H.Store.Load(id)!.Rev);
    }

    [Fact]
    public async Task NoExperimentalFolderIsAnEmptyReport()
    {
        using var r = new Rig();
        Directory.Delete(r.Source);

        var report = await r.Importer.RunAsync(apply: true, None);

        Assert.False(report.SourceFound);
        Assert.Equal(0, report.Documents);
        Assert.False(Directory.Exists(r.Source));
    }
}
