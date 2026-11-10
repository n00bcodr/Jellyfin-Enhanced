using Jellyfin.Plugin.JellyfinEnhanced.Features.Bookmarks;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Bookmarks.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Transport;
using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Admin.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Maintenance;

namespace JE.Tests.Features.Bookmarks;

[Collection("Plugin singleton")]
public class BookmarkDocumentTests
{
    private const string User = "abcdefabcdefabcdefabcdefabcdefab";
    private static string PathFor(CoreFixture f) => Path.Combine(f.ConfigRoot, User, "bookmark.json");
    private static void Write(CoreFixture f, string json) { Directory.CreateDirectory(Path.GetDirectoryName(PathFor(f))!); File.WriteAllText(PathFor(f), json); }
    private static BookmarkOperation Op(string kind, string? id = null, string? fields = null, string? source = null, double? offset = null) => new()
    { Kind = kind, Id = id, SourceId = source, Offset = offset, Fields = fields == null ? null : JsonSerializer.Deserialize<JsonElement>(fields) };
    private static BookmarkMutationRequest Request(string revision, params BookmarkOperation[] operations) => new() { Revision = revision, Operations = operations };

    [Theory]
    [InlineData("1e400")]
    [InlineData("1e-400")]
    [InlineData("0.123456789012345678901234567890123456789")]
    [InlineData("900719925474099312345678901234567890")]
    public void EditsAndCopiesPreserveRawProvenance(string number)
    {
        using var f = new CoreFixture();
        Write(f, "{\"future\":" + number + ",\"Bookmarks\":{\"Bm_A\":{\"ItemId\":\"old\",\"Timestamp\":12.5,\"Label\":\"keep\",\"CreatedAt\":\"creation\",\"future\":" + number + "},\"invalid\":17}}");
        var service = new BookmarkDocumentService(f.Manager);
        var snapshot = service.Read(User);
        Assert.True(service.TryMutate(User, Request(snapshot.Revision, Op("edit", "Bm_A", "{\"label\":\"edited\"}")), out var edited));
        Assert.True(service.TryMutate(User, Request(edited!.Revision, Op("copy", "Bm_B", "{\"itemId\":\"new\",\"seasonNumber\":2,\"episodeNumber\":4}", "Bm_A", 2.25)), out var copied));
        Assert.True(service.TryMutate(User, Request(copied!.Revision, Op("replace", "Bm_C", "{\"itemId\":\"third\"}", "Bm_B", -100)), out _));
        using var json = JsonDocument.Parse(File.ReadAllText(PathFor(f)));
        Assert.Equal(number, json.RootElement.GetProperty("future").GetRawText());
        var records = json.RootElement.GetProperty("Bookmarks");
        Assert.False(records.TryGetProperty("Bm_B", out _));
        Assert.Equal(17, records.GetProperty("invalid").GetInt32());
        foreach (var id in new[] { "Bm_A", "Bm_C" })
        {
            var record = records.GetProperty(id);
            Assert.Equal(number, record.GetProperty("future").GetRawText());
            Assert.Equal("edited", record.GetProperty("Label").GetString());
            Assert.Equal("creation", record.GetProperty("CreatedAt").GetString());
        }
        Assert.Equal(0, records.GetProperty("Bm_C").GetProperty("Timestamp").GetDouble());
        Assert.Equal(4, records.GetProperty("Bm_C").GetProperty("episodeNumber").GetInt32());
    }
    [Theory]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("{\"bookmarks\":null}")]
    [InlineData("broken")]
    public void CorruptionNeverBecomesMissingOrGetsOverwritten(string raw)
    {
        using var f = new CoreFixture(); Write(f, raw);
        var service = new BookmarkDocumentService(f.Manager);
        Assert.Throws<InvalidDataException>(() => service.Read(User));
        Assert.Throws<InvalidDataException>(() => { var revision = f.Manager.ReadUserConfigurationDocument(User, "bookmark.json").Revision; service.TryMutate(User, Request(revision, Op("delete-all")), out _); });
        Assert.Equal(raw, File.ReadAllText(PathFor(f)));
    }
    [Fact]
    public void MissingCreatesWithCasAndLegacyWritesInvalidateRevision()
    {
        using var f = new CoreFixture(); var service = new BookmarkDocumentService(f.Manager);
        Assert.Equal("missing", service.Read(User).Revision); Assert.False(File.Exists(PathFor(f)));
        Assert.True(service.TryMutate(User, Request("missing", Op("create", "new", "{\"itemId\":\"item\",\"timestamp\":1.25}")), out var saved));
        Assert.False(service.TryMutate(User, Request("missing", Op("delete-all")), out _));
        f.Manager.SaveUserConfiguration(User, "bookmark.json", new { bookmarks = new { legacy = new { timestamp = 2 } } });
        var bytes = File.ReadAllBytes(PathFor(f));
        Assert.False(service.TryMutate(User, Request(saved!.Revision, Op("delete-all")), out _));
        Assert.Equal(bytes, File.ReadAllBytes(PathFor(f)));
    }
    [Fact]
    public void InvalidBatchIsAtomicAndRetargetedSourceCannotBeCopied()
    {
        using var f = new CoreFixture(); Write(f, "{\"bookmarks\":{\"a\":{\"itemId\":\"i\",\"timestamp\":2}}}");
        var service = new BookmarkDocumentService(f.Manager); var read = service.Read(User); var bytes = File.ReadAllBytes(PathFor(f));
        Assert.Throws<ArgumentException>(() => service.TryMutate(User, Request(read.Revision, Op("offset", "a", offset: 3), Op("delete", "missing")), out _));
        Assert.Equal(bytes, File.ReadAllBytes(PathFor(f)));
        Assert.Throws<ArgumentException>(() => service.TryMutate(User, Request(read.Revision, new BookmarkOperation { Kind = "copy", Id = "b", SourceId = "a", ExpectedItemId = "other" }), out _));
        Assert.Equal(bytes, File.ReadAllBytes(PathFor(f)));
    }
    [Fact]
    public void BackfillDeleteAndClearRetainDocumentExtensions()
    {
        using var f = new CoreFixture(); Write(f, "{\"future\":1e400,\"bookmarks\":{\"a\":{\"itemId\":\"i\",\"timestamp\":2},\"b\":{\"episodeNumber\":8}}}");
        var service = new BookmarkDocumentService(f.Manager); var read = service.Read(User);
        Assert.True(service.TryMutate(User, Request(read.Revision, Op("backfill", "a", "{\"episodeNumber\":3,\"tvdbId\":\"episode\"}"), Op("backfill", "b", "{\"episodeNumber\":1}")), out var saved));
        using (var doc = JsonDocument.Parse(service.Read(User).Document)) Assert.Equal(8, doc.RootElement.GetProperty("bookmarks").GetProperty("b").GetProperty("episodeNumber").GetInt32());
        Assert.True(service.TryMutate(User, Request(saved!.Revision, Op("delete", "a"), Op("delete-all")), out _));
        using var final = JsonDocument.Parse(service.Read(User).Document);
        Assert.Empty(final.RootElement.GetProperty("bookmarks").EnumerateObject()); Assert.Equal("1e400", final.RootElement.GetProperty("future").GetRawText());
    }
    [Fact]
    public async Task ControllerAuthorizationConflictAndSerializedContract()
    {
        using var fixture = new ApiPluginFixture(); var user = Guid.NewGuid();
        var maintenance = new MaintenanceModeService(Moq.Mock.Of<MediaBrowser.Controller.Library.IUserManager>(), Moq.Mock.Of<MediaBrowser.Controller.Session.ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var controller = (JeBookmarksController)ApiAssetTests.Controller(typeof(JeBookmarksController), fixture.Core, maintenance, fixture.Core.Manager);
        controller.HttpContext.User = new System.Security.Claims.ClaimsPrincipal();
        controller.Request.Headers.Cookie = "je-admin=true; userId=" + user.ToString("N");
        controller.Request.Headers["X-JE-Admin"] = "true";
        controller.HttpContext.Connection.RemoteIpAddress = System.Net.IPAddress.Loopback;
        Assert.IsType<ForbidResult>(controller.GetBookmarkDocument(user.ToString("N")));
        controller.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(user, false);
        Assert.IsType<ForbidResult>(controller.GetBookmarkDocument(Guid.NewGuid().ToString("N")));
        Assert.IsType<ForbidResult>(controller.MutateBookmarkDocument(Guid.NewGuid().ToString("N"), Request("missing", Op("delete-all"))));
        var directory = Path.Combine(fixture.Core.ConfigRoot, user.ToString("N")); Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, "bookmark.json"), "{\"future\":1e400,\"bookmarks\":{\"Bm_UPPER\":{\"itemId\":\"old\",\"timestamp\":2.5,\"future\":1e-400}}}");
        var result = Assert.IsType<JsonResult>(controller.GetBookmarkDocument(user.ToString("N")));
        var loaded = Assert.IsType<BookmarkDocumentResponse>(result.Value);
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root != null && !File.Exists(Path.Combine(root.FullName, "client/entries/contracts.json"))) root = root.Parent;
        Assert.NotNull(root);
        var start = new System.Diagnostics.ProcessStartInfo("node") { WorkingDirectory = root.FullName, RedirectStandardInput = true, RedirectStandardError = true, UseShellExecute = false };
        start.ArgumentList.Add("tests/frontend/contracts/check-wire.mjs"); start.ArgumentList.Add("bookmarks");
        using var process = System.Diagnostics.Process.Start(start)!; var error = process.StandardError.ReadToEndAsync();
        await process.StandardInput.WriteAsync(JsonSerializer.Serialize(loaded, Assert.IsType<JsonSerializerOptions>(result.SerializerSettings))); process.StandardInput.Close();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15)); await process.WaitForExitAsync(timeout.Token);
        Assert.True(process.ExitCode == 0, await error);
        var request = Request(loaded.Revision, Op("create", "new", "{\"itemId\":\"i\",\"timestamp\":2}"));
        var receipt = Assert.IsType<BookmarkSaveReceipt>(Assert.IsType<JsonResult>(controller.MutateBookmarkDocument(user.ToString("N"), request)).Value);
        Assert.IsType<ConflictObjectResult>(controller.MutateBookmarkDocument(user.ToString("N"), request));
        Assert.Equal(receipt.Revision, fixture.Core.Manager.ReadUserConfigurationDocument(user.ToString("N"), "bookmark.json").Revision);
        Assert.IsType<OkObjectResult>(controller.SaveUserBookmark(user.ToString("N"), new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserBookmark()));
        Assert.IsType<ConflictObjectResult>(controller.MutateBookmarkDocument(user.ToString("N"), Request(receipt.Revision, Op("delete-all"))));
        controller.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(Guid.NewGuid(), true);
        Assert.IsType<JsonResult>(controller.GetBookmarkDocument(user.ToString("N")));
    }
    [Fact]
    public async Task CompetingWritersCommitExactlyOneBatch()
    {
        using var f = new CoreFixture(); var service = new BookmarkDocumentService(f.Manager);
        var revision = service.Read(User).Revision;
        var results = await Task.WhenAll(Enumerable.Range(0, 2).Select(i => Task.Run(() => service.TryMutate(User, Request(revision, Op("create", "id" + i, "{\"timestamp\":3}")), out _))));
        Assert.Single(results, saved => saved);
        using var document = JsonDocument.Parse(service.Read(User).Document);
        Assert.Single(document.RootElement.GetProperty("bookmarks").EnumerateObject());
    }

    [Theory]
    [InlineData("\"bad\"")]
    [InlineData("-1")]
    [InlineData("1e400")]
    public void InvalidTimestampEditsLeaveStoredBytesUntouched(string timestamp)
    {
        using var f = new CoreFixture(); Write(f, "{\"bookmarks\":{\"a\":{\"timestamp\":2}}}");
        var service = new BookmarkDocumentService(f.Manager); var snapshot = service.Read(User); var bytes = File.ReadAllBytes(PathFor(f));
        Assert.Throws<ArgumentException>(() => service.TryMutate(User, Request(snapshot.Revision, Op("edit", "a", "{\"timestamp\":" + timestamp + "}")), out _));
        Assert.Equal(bytes, File.ReadAllBytes(PathFor(f)));
    }

    [Theory]
    [InlineData("2026-11-07T10:20:30.000Z")]
    [InlineData("2026-11-07T10:20:30+02:00")]
    [InlineData("2026-11-07T10:20:30.1234567Z")]
    public void DeliberateStringEditsRetainExactTextOnCreateEditAndReload(string label)
    {
        using var f = new CoreFixture(); var service = new BookmarkDocumentService(f.Manager);
        var fields = JsonSerializer.Serialize(new { itemId = "item", timestamp = 1.25, label,
            extension = new { nested = new[] { label, "plain text" } } });
        Assert.True(service.TryMutate(User, Request("missing", Op("create", "a", fields)), out var created));
        foreach (var kind in new[] { "read-created", "edit" })
        {
            if (kind == "edit") Assert.True(service.TryMutate(User, Request(created!.Revision,
                Op("edit", "a", fields)), out _));
            using var disk = JsonDocument.Parse(File.ReadAllText(PathFor(f)));
            using var wire = JsonDocument.Parse(service.Read(User).Document);
            foreach (var document in new[] { disk, wire })
            {
                var record = document.RootElement.GetProperty("bookmarks").GetProperty("a");
                Assert.Equal(label, record.GetProperty("label").GetString());
                Assert.Equal(label, record.GetProperty("extension").GetProperty("nested")[0].GetString());
            }
        }
    }
    [Theory]
    [InlineData("1e400")]
    [InlineData("1e-400")]
    [InlineData("0.123456789012345678901234567890123456789")]
    [InlineData("900719925474099312345678901234567890")]
    public void DeliberateExtensionEditsRetainExactNumbers(string literal)
    {
        using var f = new CoreFixture(); var service = new BookmarkDocumentService(f.Manager);
        Assert.True(service.TryMutate(User, Request("missing", Op("create", "a", "{\"timestamp\":1}")), out var created));
        var fields = "{\"extension\":{\"nested\":[" + literal + "]}}";
        Assert.True(service.TryMutate(User, Request(created!.Revision, Op("edit", "a", fields)), out _));
        using var wire = JsonDocument.Parse(service.Read(User).Document);
        Assert.Equal(literal, wire.RootElement.GetProperty("bookmarks").GetProperty("a")
            .GetProperty("extension").GetProperty("nested")[0].GetRawText());
    }

}
