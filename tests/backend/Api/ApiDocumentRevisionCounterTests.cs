using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Backup;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Session;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

/// <summary>
/// Stage 1 fix round 10: a per-user document's revision counts the writes of that document (with an incarnation that
/// changes when the server starts again or a backup is restored); it is never derived from the content, so a document
/// that comes back to an earlier content (changed back, or restored) never brings an earlier revision back. If-Match is
/// read as HTTP entity tags: a list of strong tags, each quoted; a weak tag never authorizes a whole replacement. A
/// restore takes each document's lock and moves its revision on, so a writer that read before the restore can't put its
/// copy over the restored one. Before, revisions were content hashes (RBS1-R10-4, -9) and the restore wrote past the
/// document locks (RBS1-R10-3).
/// </summary>
[Collection("Plugin singleton")]
public class ApiDocumentRevisionCounterTests
{
    private const string Hidden = "hidden-content.json";

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static int Status(IActionResult result) => result switch
    {
        ObjectResult o => o.StatusCode ?? 200,
        StatusCodeResult s => s.StatusCode,
        _ => 0,
    };

    private static UserHiddenContent HiddenWith(params string[] ids)
    {
        var doc = new UserHiddenContent();
        foreach (var id in ids) doc.Items[id] = new HiddenContentItem { ItemId = id };
        return doc;
    }

    private static JeBackupService Backup(CoreFixture f) => new(f.ConfigRoot, Path.Combine(f.Root, "no-configuration.xml"), () => null, f.Logger);

    private static byte[] Export(JeBackupService service)
    {
        using var stream = new MemoryStream();
        service.Export(stream, JeBackupSecrets.Exclude, null);
        return stream.ToArray();
    }

    private static string Tag(ApiPluginFixture f, Guid person)
    {
        var reader = ApiUserDocumentRevisionTests.Controller(f, person);
        return ApiUserDocumentRevisionTests.ETag(reader, reader.GetUserHiddenContent(person.ToString("N")));
    }

    // A document changed and changed back has a new revision: a writer holding the first one is refused.
    [Fact]
    public void ADocumentChangedBackHasANewRevision()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        f.Core.Manager.SaveUserConfiguration(id, Hidden, HiddenWith("a"));
        var first = Tag(f, person);
        var stale = f.Core.Manager.GetUserConfiguration<UserHiddenContent>(id, Hidden);
        stale.Items["c"] = new HiddenContentItem { ItemId = "c" };
        ApiUserDocumentRevisionTests.Controller(f, person).PatchUserHiddenContent(id, new() { Upsert = new() { ["b"] = Json("""{"ItemId":"b"}""") } });
        ApiUserDocumentRevisionTests.Controller(f, person).PatchUserHiddenContent(id, new() { Remove = new() { Json("\"b\"") } });
        Assert.NotEqual(first, Tag(f, person));
        Assert.Equal(409, Status(ApiUserDocumentRevisionTests.Controller(f, person, first).SaveUserHiddenContent(id, stale)));
        Assert.DoesNotContain("c", f.Core.Manager.GetUserConfiguration<UserHiddenContent>(id, Hidden).Items.Keys);
    }

    // Restoring the content a writer read (the backup holds it) moves the revision on all the same, and so does opening the
    // store again afterwards (a new manager over the same folder): the writer's revision is spent.
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ARevisionReadBeforeARestoreIsRefusedAfterIt(bool reopen)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        var m = f.Core.Manager;
        m.SaveUserConfiguration(id, Hidden, HiddenWith("a"));
        var tag = Tag(f, person);
        var stale = m.GetUserConfiguration<UserHiddenContent>(id, Hidden);
        stale.Items["c"] = new HiddenContentItem { ItemId = "c" };
        var service = Backup(f.Core);
        var zip = Export(service);
        m.RmwUserConfiguration<UserHiddenContent>(id, Hidden, doc => { doc.Items["b"] = new HiddenContentItem { ItemId = "b" }; return 1; });
        service.Restore(new MemoryStream(zip), null);
        if (reopen) _ = new UserConfigurationManager(f.Core.Paths.Object, f.Core.Logger);
        Assert.NotEqual(tag, Tag(f, person));
        Assert.Equal(409, Status(ApiUserDocumentRevisionTests.Controller(f, person, tag).SaveUserHiddenContent(id, stale)));
        Assert.Equal(new[] { "a" }, m.GetUserConfiguration<UserHiddenContent>(id, Hidden).Items.Keys.ToArray());
    }

    // If-Match is a list of entity tags: the current revision anywhere in it authorizes the write.
    [Fact]
    public void TheCurrentRevisionInAnIfMatchListIsAccepted()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        f.Core.Manager.SaveUserConfiguration(id, Hidden, HiddenWith("a"));
        var tag = Tag(f, person);
        var doc = f.Core.Manager.GetUserConfiguration<UserHiddenContent>(id, Hidden);
        doc.Items["b"] = new HiddenContentItem { ItemId = "b" };
        Assert.Equal(200, Status(ApiUserDocumentRevisionTests.Controller(f, person, "\"other\", " + tag).SaveUserHiddenContent(id, doc)));
        Assert.Contains("b", f.Core.Manager.GetUserConfiguration<UserHiddenContent>(id, Hidden).Items.Keys);
    }

    // A weak tag, or a value that isn't an entity tag (no quotes), never authorizes replacing the document whole.
    [Theory]
    [InlineData("weak")]
    [InlineData("bare")]
    [InlineData("star")]
    public void AWeakOrMalformedIfMatchDoesNotAuthorizeAWholeReplacement(string form)
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        f.Core.Manager.SaveUserConfiguration(id, Hidden, HiddenWith("a"));
        var tag = Tag(f, person);
        var sent = form switch { "weak" => "W/" + tag, "bare" => tag.Trim('"'), _ => "*" };
        var doc = f.Core.Manager.GetUserConfiguration<UserHiddenContent>(id, Hidden);
        doc.Items["b"] = new HiddenContentItem { ItemId = "b" };
        Assert.Equal(409, Status(ApiUserDocumentRevisionTests.Controller(f, person, sent).SaveUserHiddenContent(id, doc)));
        Assert.DoesNotContain("b", f.Core.Manager.GetUserConfiguration<UserHiddenContent>(id, Hidden).Items.Keys);
    }

    // A save answers the revision it stored (in the body, for clients that can't read headers): the same one a read hands out
    // next, and every save moves it on.
    [Fact]
    public void AnOperationsAnswerCarriesTheRevisionItStored()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        f.Core.Manager.SaveUserConfiguration(id, Hidden, HiddenWith("a"));
        var answer = (ObjectResult)ApiUserDocumentRevisionTests.Controller(f, person).PatchUserHiddenContent(id, new() { Upsert = new() { ["b"] = Json("""{"ItemId":"b"}""") } });
        var body = JsonSerializer.SerializeToElement(answer.Value);
        Assert.True(body.TryGetProperty("revision", out var revision), "the answer names the revision it stored");
        Assert.Equal(Tag(f, person), "\"" + revision.GetString() + "\"");
        var settings = (ObjectResult)ApiUserDocumentRevisionTests.Controller(f, person).PatchUserSettingsSettings(id, new() { Set = new() { ["PauseScreenDelaySeconds"] = Json("9") } });
        Assert.True(JsonSerializer.SerializeToElement(settings.Value).TryGetProperty("revision", out _));
    }

    // A read can hand the document out with its revision in the body ({ document, revision }), for clients that can't read
    // the ETag header; without the query it answers the document as before.
    [Fact]
    public void AReadCanAnswerTheDocumentWithItsRevision()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        f.Core.Manager.SaveUserConfiguration(id, Hidden, HiddenWith("a"));
        var plain = ApiUserDocumentRevisionTests.Controller(f, person);
        Assert.IsType<UserHiddenContent>(((ObjectResult)plain.GetUserHiddenContent(id)).Value);
        var reader = ApiUserDocumentRevisionTests.Controller(f, person);
        reader.HttpContext.Request.QueryString = new Microsoft.AspNetCore.Http.QueryString("?withRevision=true");
        var body = JsonSerializer.SerializeToElement(((ObjectResult)reader.GetUserHiddenContent(id)).Value);
        Assert.True(body.TryGetProperty("revision", out var revision));
        Assert.True(body.TryGetProperty("document", out var document));
        Assert.True(document.GetProperty("Items").TryGetProperty("a", out _));
        Assert.Equal(reader.HttpContext.Response.Headers.ETag.ToString(), "\"" + revision.GetString() + "\"");
    }

    // A restore waits for a write that read the document before it (the write holds the document's lock) and then puts the
    // backup's document in place: the restored document is what stays, never the write's copy over it.
    [Fact]
    public async Task ARestoreDuringASaveKeepsTheRestoredDocument()
    {
        using var f = new CoreFixture();
        var id = Guid.NewGuid().ToString("N");
        f.Manager.SaveUserConfiguration(id, Hidden, HiddenWith("b"));
        var service = Backup(f);
        var zip = Export(service);
        f.Manager.SaveUserConfiguration(id, Hidden, HiddenWith("a"));
        using var reached = new ManualResetEventSlim();
        using var resume = new ManualResetEventSlim();
        f.Manager.Saving = (_, file) =>
        {
            if (file != Hidden || reached.IsSet) return;
            reached.Set();
            if (!resume.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException();
        };
        var save = Task.Run(() => f.Manager.RmwUserConfiguration<UserHiddenContent>(id, Hidden, doc => { doc.Items["c"] = new HiddenContentItem { ItemId = "c" }; return 1; }));
        Task<JeRestoreResult>? restore = null;
        try
        {
            Assert.True(reached.Wait(TimeSpan.FromSeconds(5)));
            restore = Task.Run(() => service.Restore(new MemoryStream(zip), null));
            await Task.WhenAny(restore, Task.Delay(500));
            Assert.False(restore.IsCompleted, "the restore waits for the save that holds the document");
            resume.Set();
            await save;
            Assert.True((await restore).FilesRestored > 0);
            Assert.Equal(new[] { "b" }, f.Manager.GetUserConfiguration<UserHiddenContent>(id, Hidden).Items.Keys.ToArray());
        }
        finally
        {
            resume.Set();
            await save;
            if (restore != null) await restore;
            f.Manager.Saving = null;
        }
    }

    // A whole save without a revision from a page of an earlier JE (a signed-in session) is refused and that session is told
    // to reload (Jellyfin's own message), once for a burst of such saves; an API key gets the refusal only.
    [Fact]
    public void AnEarlierPagesWholeSaveIsRefusedAndItsSessionIsToldToReload()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        f.Core.Manager.SaveUserConfiguration(id, Hidden, HiddenWith("a"));
        var device = "device-" + Guid.NewGuid().ToString("N");
        var sessions = new Mock<ISessionManager>();
        var sent = new List<(string Session, MessageCommand Command)>();
        var session = new SessionInfo(sessions.Object, NullLogger.Instance) { Id = "session-1", DeviceId = device, UserId = person, Client = "Jellyfin Web" };
        sessions.SetupGet(s => s.Sessions).Returns(new[] { session });
        sessions.Setup(s => s.SendMessageCommand(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<MessageCommand>(), It.IsAny<CancellationToken>()))
            .Callback<string, string, MessageCommand, CancellationToken>((_, target, command, _) => sent.Add((target, command)))
            .Returns(Task.CompletedTask);
        Jellyfin.Plugin.JellyfinEnhanced.Controllers.JellyfinEnhancedController Page(bool apiKey)
        {
            var c = ApiAssetTests.Controller(f.Core, f.Core.Manager, sessions.Object);
            c.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(new[]
            {
                new Claim("Jellyfin-UserId", person.ToString()), new Claim(ClaimTypes.Role, "User"),
                new Claim("Jellyfin-DeviceId", device), new Claim("Jellyfin-Client", "Jellyfin Web"),
                new Claim("Jellyfin-IsApiKey", apiKey ? "true" : "false"),
            }, "test"));
            return c;
        }

        Assert.Equal(409, Status(Page(apiKey: true).SaveUserHiddenContent(id, HiddenWith("a", "x"))));
        Assert.Empty(sent);
        Assert.Equal(409, Status(Page(apiKey: false).SaveUserHiddenContent(id, HiddenWith("a", "y"))));
        Assert.Equal(409, Status(Page(apiKey: false).SaveUserHiddenContent(id, HiddenWith("a", "z"))));
        var notice = Assert.Single(sent);
        Assert.Equal("session-1", notice.Session);
        Assert.Contains("reload", notice.Command.Text, StringComparison.OrdinalIgnoreCase);
        Assert.Null(notice.Command.TimeoutMs);
        Assert.Equal(new[] { "a" }, f.Core.Manager.GetUserConfiguration<UserHiddenContent>(id, Hidden).Items.Keys.ToArray());
    }
}
