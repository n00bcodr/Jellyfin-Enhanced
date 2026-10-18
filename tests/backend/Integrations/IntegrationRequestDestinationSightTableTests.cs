using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Rig = JE.Tests.IntegrationSeerrRequestOptionsTests.Rig;

namespace JE.Tests;

/// <summary>
/// Review round 5 (security-r5-1): who may decline, approve or list a request is judged where it ACTUALLY goes, by the
/// production policy (no stub). A Seerr-mode request with an administrator's Seerr choice lands in the root folder chosen
/// on the Seerr server chosen, whatever the title's ordinary arr folder is: a Manager who can't open that folder's library
/// can't see the request there, so can't decline or approve it and doesn't get it listed. Table: where it goes (a Seerr
/// folder on a verified linked instance, an unlinked or ambiguous server, a repointed server, a stale options stamp,
/// an arr folder in Jellyfin Enhanced handling) × who looks (blocked from that library, every
/// library, only the libraries they were given) × what they do. The title's ordinary folder is one every one of them sees.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationRequestDestinationSightTableTests
{
    private const string Title = "movie:tmdb:603";

    /// <summary>Where the request goes.</summary>
    public enum Where
    {
        /// <summary>Seerr's server 1, folder /kids; the default Radarr is explicitly linked and its connection verified.</summary>
        SeerrDefault,
        /// <summary>No link for server 1; another server maps the same /kids root to ordinary movies.</summary>
        SeerrUnlinked,
        /// <summary>Two instances claim server 1 with different /kids mappings.</summary>
        SeerrAmbiguous,
        /// <summary>A stale imported id points to a different connection now.</summary>
        SeerrRepointed,
        /// <summary>Seerr A is replaced by B with the same server id and root, linked to an accessible destination.</summary>
        SeerrReplaced,
        /// <summary>As SeerrReplaced, with a changed Seerr URL instead of a changed key.</summary>
        SeerrReplacedUrl,
        /// <summary>Seerr's server 1, folder /kids, on the instance linked to that Seerr server (its own mapping: /kids is /media/kids).</summary>
        SeerrLinked,
        /// <summary>As <see cref="SeerrDefault"/>, and Seerr's servers changed since (the choice's stamp is stale).</summary>
        SeerrStale,
        /// <summary>Jellyfin Enhanced handling, the arr folder /kids.</summary>
        JeFolder,
    }

    /// <summary>Who looks at it.</summary>
    public enum Sight
    {
        /// <summary>A Manager with every library but the hidden one blocked.</summary>
        Blind,
        /// <summary>A Manager with every library.</summary>
        Sighted,
        /// <summary>A Manager given only the ordinary and the hidden library.</summary>
        Entitled,
        /// <summary>An administrator blocked from an unrelated library.</summary>
        RestrictedAdmin,
        /// <summary>An administrator blocked from the resolved destination itself.</summary>
        DestinationBlockedAdmin,
    }

    public static TheoryData<Where, Sight, string> Every()
    {
        var rows = new TheoryData<Where, Sight, string>();
        foreach (var where in Enum.GetValues<Where>())
            foreach (var sight in Enum.GetValues<Sight>())
                foreach (var act in new[] { "decline", "approve", "list", "close", "hub", "notice" }) rows.Add(where, sight, act);
        return rows;
    }

    private sealed class Setup : IDisposable
    {
        public Rig Rig { get; } = new();
        public Dictionary<Sight, StatusViewer> People { get; } = new();
        public string Id { get; private set; } = string.Empty;

        public async Task Build(Where where)
        {
            var rig = Rig;
            rig.Config.ArrRequestBackend = where == Where.JeFolder ? "je" : "seerr";
            // Three Managers (each with Seerr's manage permission), added before anything reads Seerr's users.
            var roles = JsonSerializer.Deserialize<Dictionary<string, JsonObject>>(rig.Config.ArrRequestUsers)!;
            var seerrId = 20;
            foreach (var sight in Enum.GetValues<Sight>())
            {
                var person = rig.View.AddUser(sight is Sight.RestrictedAdmin or Sight.DestinationBlockedAdmin);
                People[sight] = person;
                roles[person.UserId.ToString("N")] = new JsonObject { ["Role"] = "Manager" };
                rig.Fake.Users.Add(new JsonObject { ["id"] = seerrId++, ["jellyfinUserId"] = person.UserId.ToString("N"), ["permissions"] = 32 | 16 | 8192, ["displayName"] = sight.ToString() });
            }
            rig.Config.ArrRequestUsers = JsonSerializer.Serialize(roles);

            // Jellyfin's libraries: the ordinary movies and the hidden one (where Seerr's /kids lands).
            var movies = rig.Access.AddLibrary("Movies", "movies", "/data/movies");
            var hidden = rig.Access.AddLibrary("Hidden", "movies", where is Where.SeerrLinked or Where.SeerrUnlinked or Where.SeerrAmbiguous or Where.SeerrRepointed ? "/media/kids" : "/kids");
            var other = rig.Access.AddLibrary("Other", "movies", "/other");
            ((User)People[Sight.RestrictedAdmin].Handle!).SetPreference(PreferenceKind.BlockedMediaFolders, new[] { other.Id });
            ((User)People[Sight.DestinationBlockedAdmin].Handle!).SetPreference(PreferenceKind.BlockedMediaFolders, new[] { hidden.Id });
            var blind = (User)People[Sight.Blind].Handle!;
            blind.SetPreference(PreferenceKind.BlockedMediaFolders, new[] { hidden.Id });
            var entitled = (User)People[Sight.Entitled].Handle!;
            entitled.SetPermission(PermissionKind.EnableAllFolders, false);
            entitled.SetPreference(PreferenceKind.EnabledFolders, new[] { movies.Id, hidden.Id });

            // The title is in Radarr at its ordinary folder (which every Manager sees).
            var arr = rig.Lab.Arr;
            arr.Radarr.Movies.Add(new JsonObject { ["id"] = 33, ["tmdbId"] = 603, ["title"] = "The Matrix", ["monitored"] = true, ["hasFile"] = false, ["path"] = "/data/movies/The Matrix" });
            arr.Radarr.RootFolders.Add(new JsonObject { ["path"] = "/kids", ["freeSpace"] = 1_000_000_000_000L, ["accessible"] = true });
            var mappings = new JsonArray(new JsonObject { ["ArrPath"] = "/data/movies", ["JellyfinPath"] = "/data/movies" });
            if (where != Where.SeerrLinked) mappings.Add(new JsonObject { ["ArrPath"] = "/kids", ["JellyfinPath"] = "/kids" });
            arr.Edit("Radarr", row =>
            {
                row["PathMappings"] = mappings;
                if (where is Where.SeerrDefault or Where.SeerrStale or Where.SeerrAmbiguous or Where.SeerrRepointed or Where.SeerrReplaced or Where.SeerrReplacedUrl) row["SeerrServerId"] = 1;
                if (where is Where.SeerrUnlinked or Where.SeerrRepointed)
                {
                    row["SeerrServerId"] = where == Where.SeerrRepointed ? 1 : 0;
                    row["PathMappings"] = new JsonArray(new JsonObject { ["ArrPath"] = "/kids", ["JellyfinPath"] = "/data/movies" });
                }
            });
            if (where is Where.SeerrLinked or Where.SeerrAmbiguous)
            {
                // Another instance is the arr behind Seerr's server 1 (imported from Seerr): /kids there is /media/kids.
                arr.Edit("Radarr 4K", row =>
                {
                    row["SeerrServerId"] = 1;
                    row["PathMappings"] = new JsonArray(new JsonObject { ["ArrPath"] = "/kids", ["JellyfinPath"] = "/media/kids" });
                });
            }
            // The linked server's connection is known, not merely a coincidentally equal numeric id.
            if (where is not (Where.SeerrUnlinked or Where.SeerrRepointed))
            {
                var through = arr.Instance(where == Where.SeerrLinked ? "Radarr 4K" : "Radarr");
                var uri = new Uri(through.Url);
                rig.Fake.Connections["radarr/1"] = new JsonObject { ["hostname"] = uri.Host, ["port"] = uri.Port,
                    ["useSsl"] = false, ["baseUrl"] = uri.AbsolutePath.TrimEnd('/'), ["apiKey"] = arr.Arr.Registry.ResolveApiKey(through) };
            }
            Assert.True((await arr.Store.RefreshLibraryNowAsync(arr.Instance("Radarr"), default)).Ok);
            if (arr.Store.WarmSystem(arr.Instance("Radarr")) is { } system) await system;

            // An administrator's request going there, waiting for an OK.
            var input = where == Where.JeFolder
                ? new MutationInput { Key = Title, RootFolder = "/kids" }
                : new MutationInput { Key = Title, SeerrServerId = 1, SeerrProfileId = 6, SeerrRootFolder = "/kids", SeerrOptions = await rig.Stamp(1) };
            var asked = await rig.Service.CreateAsync(rig.Admin.UserId, new CreateRequest("sight-" + where, input), default, new RequestOrigin(RequestOrigin.InteractiveKind) { RequireApproval = true });
            Assert.True(asked.HttpStatus == 201, asked.Reason + ": " + asked.Message);
            Id = asked.RequestId!;
            Assert.Equal("pending", rig.Ledger.Find(Id)!.Status);
            if (where is Where.SeerrReplaced or Where.SeerrReplacedUrl)
            {
                var oldSource = rig.Lab.Source;
                if (where == Where.SeerrReplaced) rig.Config.JellyseerrApiKey = "replacement-seerr-key";
                else rig.Config.JellyseerrUrls = "http://replacement-seerr.lan:5055";
                Assert.NotEqual(oldSource, rig.Lab.Source);
                arr.Edit("Radarr", row => row["SeerrServerId"] = null);
                arr.Edit("Radarr 4K", row =>
                {
                    row["SeerrServerId"] = 1;
                    row["PathMappings"] = new JsonArray(new JsonObject { ["ArrPath"] = "/kids", ["JellyfinPath"] = "/data/movies" });
                });
                var replacement = arr.Instance("Radarr 4K");
                var uri = new Uri(replacement.Url);
                rig.Fake.Connections["radarr/1"] = new JsonObject { ["hostname"] = uri.Host, ["port"] = uri.Port,
                    ["useSsl"] = false, ["baseUrl"] = uri.AbsolutePath.TrimEnd('/'), ["apiKey"] = arr.Arr.Registry.ResolveApiKey(replacement) };
                await rig.Stamp(1);
            }
            if (where == Where.SeerrStale)
            {
                // Seerr's server 1 gets another root folder: the choice's stamp no longer fits (that never blocks a withdrawal).
                ((JsonArray)rig.Fake.ServiceDetails["radarr/1"]["rootFolders"]!).Add(new JsonObject { ["id"] = 9, ["path"] = "/kids-new", ["freeSpace"] = 1_000_000 });
                rig.Lab.Now = rig.Lab.Now.AddMinutes(2);
            }
        }

        public void Dispose() => Rig.Dispose();
    }

    /// <summary>Production policy: only someone who sees where a request goes may decline, approve or list it.</summary>
    [Theory]
    [MemberData(nameof(Every))]
    public async Task OnlySomeoneWhoSeesWhereARequestActuallyGoesMayDeclineApproveOrListIt(Where where, Sight sight, string act)
    {
        using var s = new Setup();
        await s.Build(where);
        var who = s.People[sight].UserId;
        // A synchronous list starts no reads. Once the connection facts expire, only every-library callers see it
        // until async preparation refreshes them; a stale options stamp alone still never blocks a withdrawal.
        var unknown = where is Where.SeerrUnlinked or Where.SeerrAmbiguous or Where.SeerrRepointed or Where.SeerrReplaced or Where.SeerrReplacedUrl || where == Where.SeerrStale && act is "list" or "hub" or "notice";
        var admin = sight is Sight.RestrictedAdmin or Sight.DestinationBlockedAdmin;
        var sees = unknown ? sight == Sight.Sighted || admin : sight is not (Sight.Blind or Sight.DestinationBlockedAdmin);
        var rig = s.Rig;
        switch (act)
        {
            case "close":
            case "decline":
            {
                if (act == "close") await rig.Policy.PrepareAsync(who, rig.Ledger.Find(s.Id)!.Input, default);
                var outcome = act == "close" ? rig.Service.Close(s.Id, who, "Not now.") : await rig.Service.DeclineAsync(s.Id, who, "Not now.", default);
                if (sees)
                {
                    // A stale choice is often why it waits: it never stops a decline.
                    Assert.True(outcome.HttpStatus == 200, outcome.Reason + ": " + outcome.Message);
                    Assert.Equal("declined", rig.Ledger.Find(s.Id)!.Status);
                }
                else
                {
                    Assert.Equal(("not_visible_to_user", 403), (outcome.Reason, outcome.HttpStatus));
                    Assert.Equal("pending", rig.Ledger.Find(s.Id)!.Status);
                }
                break;
            }
            case "approve":
            {
                var outcome = await rig.Service.ApproveAsync(s.Id, who, null, default);
                if (sees && where is Where.SeerrStale or Where.SeerrReplaced or Where.SeerrReplacedUrl)
                {
                    // A stale choice needs an administrator's fresh one, whoever approves.
                    Assert.Equal("seerr_options_changed", outcome.Reason);
                    Assert.Equal("pending", rig.Ledger.Find(s.Id)!.Status);
                }
                else if (sees)
                {
                    Assert.True(outcome.HttpStatus == 200, outcome.Reason + ": " + outcome.Message);
                    Assert.Equal("queued", rig.Ledger.Find(s.Id)!.Status);
                }
                else
                {
                    Assert.Equal(("not_visible_to_user", 403), (outcome.Reason, outcome.HttpStatus));
                    Assert.Equal("pending", rig.Ledger.Find(s.Id)!.Status);
                }
                break;
            }
            case "notice":
            {
                Assert.Equal(sees, Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify.NotificationService.MaySeeAsk(
                    rig.Policy, who, Title, new Dictionary<string, string>(), rig.Ledger, "approval|je|" + s.Id));
                break;
            }
            case "hub":
            {
                await rig.Policy.PrepareIdentityAsync(who, true, default);
                var directory = new IntegrationRequestHouseholdTests.FakeDirectory();
                var hub = new RequestHubProjection(rig.Service, directory, null, (_, _, _) => Task.FromResult<HubTitleMeta?>(null), () => rig.Lab.Now);
                var body = await hub.ApprovalsAsync(s.People[sight], default);
                var items = JsonNode.Parse(body.Json)!["items"]!.AsArray();
                Assert.Equal(sees, items.Any(i => (string?)i!["id"] == s.Id));
                Assert.Equal(sees ? 1 : 0, hub.Counts(who, rig.Service.Identity(who)).NeedOk);
                break;
            }
            default:
            {
                var items = JsonNode.Parse(rig.Service.List(who, true).Json)!["items"]!.AsArray().Select(i => (string)i!["id"]!).ToList();
                Assert.Equal(sees, items.Contains(s.Id));
                break;
            }
        }
    }
}
