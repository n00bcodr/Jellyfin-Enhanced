using System.Security.Claims;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

// The 4c1 routes of AcquireListsController: a person first (403 user_required, even while lists are off), then the
// lists switch (404 disabled); the request routes' own switches (requests_disabled, request_all_disabled for more than
// one entry or "all"); the administrators' importer routes (admin_required, disabled, the report; a dry run writes nothing).
[Collection("Plugin singleton")]
public class ListsRequestRoutesTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    private sealed class Rig : IDisposable
    {
        public ListsAcquisitionTests.Rig R { get; } = new();
        public ListsHarness H => R.H;
        public User Member { get; }
        public User Admin { get; }
        public ExperimentalListImporter Importer { get; }
        public string Source { get; }
        public Placeholder First { get; } = ListsHarness.Movie(603, "2020-01-01");
        public Placeholder Second { get; } = ListsHarness.Movie(604, "2020-01-01");

        public Rig()
        {
            Member = R.Person("member");
            Admin = R.Person("admin", "Admin");
            Source = Path.Combine(H.Plugin.Core.ConfigRoot, ExperimentalListImporter.SourceFolderName);
            Importer = new ExperimentalListImporter(Source, H.Store, H.Host, H.Users.Object, H.Plugin.Core.Logger);
            var config = H.Plugin.Plugin.Configuration;
            config.ArrPhase4ListRequestsEnabled = true;
            config.ArrPhase4ListRequestAllEnabled = true;
            R.Seed(First, Second).GetAwaiter().GetResult();
        }

        public Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration Config => H.Plugin.Plugin.Configuration;

        public AcquireListsController Controller(ClaimsPrincipal principal, bool acquisition = true, bool importer = true)
        {
            var controller = new AcquireListsController(H.Users.Object, H.Access, H.Service, H.Plugin.Core.Logger, acquisition ? R.Acquisition : null, importer ? Importer : null)
            {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
            };
            controller.HttpContext.User = principal;
            return controller;
        }

        public AcquireListsController As(User user, bool acquisition = true, bool importer = true) =>
            Controller(TestCallers.Principal(user.Id, ListAccessService.IsAdmin(user)), acquisition, importer);

        public void Dispose() => R.Dispose();
    }

    private static (int Status, string? Code) Answer(IActionResult result)
    {
        var obj = Assert.IsAssignableFrom<ObjectResult>(result);
        return (obj.StatusCode ?? 200, (obj.Value as ListErrorDto)?.Code);
    }

    private static T Body<T>(IActionResult result)
    {
        var obj = Assert.IsAssignableFrom<ObjectResult>(result);
        Assert.True(obj.StatusCode is null or 200, "status " + obj.StatusCode);
        return Assert.IsType<T>(obj.Value);
    }

    private static ListRequestPreviewRequest Preview(params string[] ids) => new() { PlaceholderIds = ids.ToList() };

    private static ListRequestSubmitRequest Submit(string client, params string[] ids) => new() { ClientId = client, PlaceholderIds = ids.ToList() };

    [Fact]
    public async Task AnApiKeyOrAnUnknownUserIsRefusedAsUserRequiredEvenWhileListsAreOff()
    {
        using var r = new Rig();
        var list = r.R.ListIdN;
        foreach (var listsOn in new[] { true, false })
        {
            r.Config.ArrPhase4ListPlaceholdersEnabled = listsOn;
            foreach (var caller in new[] { TestCallers.ApiKey(), TestCallers.Unknown() })
            {
                var c = r.Controller(caller);
                Assert.Equal((403, "user_required"), Answer(await c.GetList(list, None)));
                Assert.Equal((403, "user_required"), Answer(await c.PreviewRequests(list, Preview(r.First.Id), None)));
                Assert.Equal((403, "user_required"), Answer(await c.SubmitRequests(list, Submit("c1", r.First.Id), None)));
                // The importer routes are for administrators: a caller that isn't a person isn't one.
                Assert.Equal((403, "admin_required"), Answer(await c.ImportDryRun(None)));
                Assert.Equal((403, "admin_required"), Answer(await c.ImportApply(None)));
            }
        }

        Assert.Equal(0, r.R.Rows("request_operations"));
    }

    [Fact]
    public async Task WhileListsAreOffAPersonGetsNotFoundDisabled()
    {
        using var r = new Rig();
        r.Config.ArrPhase4ListPlaceholdersEnabled = false;
        var c = r.As(r.Member);

        Assert.Equal((404, "disabled"), Answer(await c.GetList(r.R.ListIdN, None)));
        Assert.Equal((404, "disabled"), Answer(await c.PreviewRequests(r.R.ListIdN, Preview(r.First.Id), None)));
        Assert.Equal((404, "disabled"), Answer(await c.SubmitRequests(r.R.ListIdN, Submit("c1", r.First.Id), None)));
        Assert.Equal(0, r.R.Rows("request_operations"));
    }

    [Fact]
    public async Task TheRequestRoutesFollowTheirOwnSwitches()
    {
        using var r = new Rig();
        var list = r.R.ListIdN;

        // Requests off (or no request service): refused before anything else.
        r.Config.ArrPhase4ListRequestsEnabled = false;
        Assert.Equal((403, "requests_disabled"), Answer(await r.As(r.Member).PreviewRequests(list, Preview(r.First.Id), None)));
        Assert.Equal((403, "requests_disabled"), Answer(await r.As(r.Member).SubmitRequests(list, Submit("c1", r.First.Id), None)));
        r.Config.ArrPhase4ListRequestsEnabled = true;
        Assert.Equal((403, "requests_disabled"), Answer(await r.As(r.Member, acquisition: false).SubmitRequests(list, Submit("c1", r.First.Id), None)));

        // Request all missing off: one entry is fine, more than one (or "all") is refused.
        r.Config.ArrPhase4ListRequestAllEnabled = false;
        Assert.Equal((403, "request_all_disabled"), Answer(await r.As(r.Member).PreviewRequests(list, Preview(r.First.Id, r.Second.Id), None)));
        Assert.Equal((403, "request_all_disabled"), Answer(await r.As(r.Member).PreviewRequests(list, new ListRequestPreviewRequest { All = true }, None)));
        Assert.Equal((403, "request_all_disabled"), Answer(await r.As(r.Member).SubmitRequests(list, Submit("c2", r.First.Id, r.Second.Id), None)));
        Assert.Equal(0, r.R.Rows("request_operations"));
        var one = Body<ListRequestPreviewDto>(await r.As(r.Member).PreviewRequests(list, Preview(r.First.Id), None));
        Assert.Equal("request", one.Items.Single().Outcome);
        var asked = Body<ListRequestSubmitDto>(await r.As(r.Member).SubmitRequests(list, Submit("c3", r.First.Id), None));
        Assert.NotNull(asked.View);
        Assert.Equal(1, r.R.Rows("wants"));

        // Both on: a batch goes through.
        r.Config.ArrPhase4ListRequestAllEnabled = true;
        var all = Body<ListRequestPreviewDto>(await r.As(r.Member).PreviewRequests(list, new ListRequestPreviewRequest { All = true }, None));
        Assert.Equal(new[] { r.First.Id, r.Second.Id }, all.Items.Select(i => i.PlaceholderId));
        Body<ListRequestSubmitDto>(await r.As(r.Member).SubmitRequests(list, Submit("c4", r.First.Id, r.Second.Id), None));
        Assert.Equal(2, r.R.Rows("wants"));
    }

    [Fact]
    public async Task TheImporterRoutesAreForAdministratorsWhileListsAreOn()
    {
        using var r = new Rig();
        var owner = r.R.Owner;
        var target = r.H.Host.AddPlaylist(owner);
        var id = target.Info.Id.ToString("N");
        Directory.CreateDirectory(r.Source);
        File.WriteAllText(Path.Combine(r.Source, id + ".json"),
            "{\"schema\":1,\"listId\":\"" + id + "\",\"listKind\":\"playlist\",\"rev\":2,\"order\":[],\"items\":[],\"intents\":[]}");
        var storeFiles = Directory.GetFiles(r.H.Store.DirectoryPath, "*", SearchOption.AllDirectories).OrderBy(f => f, StringComparer.Ordinal).ToList();

        Assert.Equal((403, "admin_required"), Answer(await r.As(r.Member).ImportDryRun(None)));
        Assert.Equal((403, "admin_required"), Answer(await r.As(r.Member).ImportApply(None)));

        r.Config.ArrPhase4ListPlaceholdersEnabled = false;
        Assert.Equal((404, "disabled"), Answer(await r.As(r.Admin).ImportDryRun(None)));
        Assert.Equal((404, "disabled"), Answer(await r.As(r.Admin).ImportApply(None)));
        r.Config.ArrPhase4ListPlaceholdersEnabled = true;
        Assert.Equal((404, "disabled"), Answer(await r.As(r.Admin, importer: false).ImportDryRun(None)));

        var dry = Body<ListImportReport>(await r.As(r.Admin).ImportDryRun(None));
        Assert.False(dry.Applied);
        Assert.Equal(id, Assert.Single(dry.Imported).ListId);
        Assert.Equal(storeFiles, Directory.GetFiles(r.H.Store.DirectoryPath, "*", SearchOption.AllDirectories).OrderBy(f => f, StringComparer.Ordinal));
        Assert.Null(r.H.Store.Load(id));

        var applied = Body<ListImportReport>(await r.As(r.Admin).ImportApply(None));
        Assert.True(applied.Applied);
        Assert.Equal("import", r.H.Store.Load(id)!.Reconcile);
    }
}
