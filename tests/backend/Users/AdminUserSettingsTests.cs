using System.Security.Claims;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Users;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class AdminUserSettingsTests
{
    private sealed class Fixture : IDisposable
    {
        public CoreFixture Files { get; } = new();
        public IntegrationRequestLedgerTests.Rig R { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public AdminUserSettingsService Service { get; }
        public int Saves { get; private set; }
        public bool FailSave { get; set; }
        public Fixture()
        {
            ((User)R.View.Users[R.Admin].Handle!).SetPermission(PermissionKind.IsAdministrator, true);
            Users.Setup(x => x.GetUserById(It.IsAny<Guid>())).Returns((Guid id) => R.View.Users.TryGetValue(id, out var v) ? (User)v.Handle! : null);
#if NET9_0
            Users.SetupGet(x => x.Users).Returns(() => R.View.Users.Values.Select(v => (User)v.Handle!).ToList());
#else
            Users.Setup(x => x.GetUsers()).Returns(() => R.View.Users.Values.Select(v => (User)v.Handle!).ToList());
#endif
            Service = new(R.Service, Users.Object, Files.Manager, R.Audit, _ => { if (FailSave) throw new IOException("write failed"); Saves++; });
        }
        public AcquireAdminUsersController As(Guid? id = null, bool key = false)
        {
            var c = new AcquireAdminUsersController(Service, Users.Object) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
            c.HttpContext.User = TestCallers.Principal(id ?? R.Admin, true);
            if (key) ((ClaimsIdentity)c.User.Identity!).AddClaim(new("Jellyfin-IsApiKey", "True"));
            return c;
        }
        public JsonElement Read(Guid? id = null) => Json(Service.Read(id ?? R.Member).Body);
        public string Revision(string group = "policy") => Read().GetProperty("revisions").GetProperty(group).GetString()!;
        public AdminUserResult Patch(string group, string fields, string? revision = null) => Service.Patch(R.Admin, R.Member, group,
            JsonDocument.Parse("{\"revision\":\"" + (revision ?? Revision(group)) + "\"," + fields + "}").RootElement);
        public void Dispose() { Files.Dispose(); R.Dispose(); }
    }
    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value, new JsonSerializerOptions(JsonSerializerDefaults.Web));

    [Theory]
    [InlineData("Member")][InlineData("Kid")][InlineData("Trusted")][InlineData("Manager")][InlineData("Watcher")]
    public async Task EveryRouteRequiresAHumanJellyfinAdministrator(string role)
    {
        using var f = new Fixture(); var id = f.R.Add(role); var c = f.As(id);
        Assert.Equal(403, Assert.IsType<ObjectResult>(c.Summary()).StatusCode);
        Assert.Equal(403, Assert.IsType<ObjectResult>(await c.GetUser(f.R.Member.ToString())).StatusCode);
        Assert.Equal(403, Assert.IsType<ObjectResult>(c.Policy(f.R.Member.ToString(), JsonDocument.Parse("{}").RootElement)).StatusCode);
        Assert.Equal("private, no-store", c.Response.Headers.CacheControl);
        Assert.Equal(0, f.Saves);
    }
    [Fact]
    public void ApiKeysEmptyUnknownAndDisabledCallersAreRefusedEvenWithAdminClaims()
    {
        using var f = new Fixture();
        foreach (var c in new[] { f.As(key:true), f.As(Guid.Empty), f.As(Guid.NewGuid()) }) Assert.Equal(403, Assert.IsType<ObjectResult>(c.Summary()).StatusCode);
        ((User)f.R.View.Users[f.R.Admin].Handle!).SetPermission(PermissionKind.IsDisabled, true);
        Assert.Equal(403, Assert.IsType<ObjectResult>(f.As().Summary()).StatusCode);
    }
    [Fact]
    public void ReadsDoNotCreateAnyPersonalFilesAndIncludeDisabledTargets()
    {
        using var f = new Fixture(); var before = Directory.GetFileSystemEntries(f.Files.ConfigRoot);
        ((User)f.R.View.Users[f.R.Member].Handle!).SetPermission(PermissionKind.IsDisabled,true);
        Assert.Equal(200, f.Service.Read(f.R.Member).Status);
        Assert.Equal(200, Assert.IsType<ObjectResult>(f.As().Summary()).StatusCode);
        Assert.Equal(before, Directory.GetFileSystemEntries(f.Files.ConfigRoot));
        Assert.Equal(0,f.Saves);
        Assert.Equal(404, f.Service.Read(Guid.NewGuid()).Status);
    }
    [Fact]
    public void AbsentNullAndEmptyGrantsAreDistinctAndUnrelatedFieldsArePreserved()
    {
        using var f = new Fixture();
        Assert.Equal(200, f.Patch("policy", "\"role\":\"Kid\",\"quotaGb\":12,\"fourKInstances\":[]").Status);
        Assert.Equal(200, f.Patch("policy", "\"quotaLimit\":3").Status);
        var stored = f.Read().GetProperty("policy").GetProperty("stored");
        Assert.Equal("Kid",stored.GetProperty("role").GetString()); Assert.Equal(12,stored.GetProperty("quotaGb").GetDouble());
        Assert.Equal(0,stored.GetProperty("fourKInstances").GetArrayLength());
        Assert.Equal(200,f.Patch("policy", "\"role\":null,\"fourKInstances\":null").Status);
        stored = f.Read().GetProperty("policy").GetProperty("stored");
        Assert.Equal(JsonValueKind.Null,stored.GetProperty("role").ValueKind);
        Assert.Equal(JsonValueKind.Null,stored.GetProperty("fourKInstances").ValueKind);
        Assert.Equal(3,stored.GetProperty("quotaLimit").GetInt32());
    }
    [Theory]
    [InlineData("\"role\":\"Admin\"")][InlineData("\"quotaGb\":-1")][InlineData("\"quotaLimit\":-2")]
    [InlineData("\"fourKInstances\":[\"unknown\"]")][InlineData("\"autoMovieRequests\":true")]
    [InlineData("\"quotaLimit\":4,\"quotaLimit\":5")]
    public void InvalidPolicyNeverPartiallyWrites(string fields)
    {
        using var f = new Fixture(); var before = f.R.Policy.Configuration.ArrRequestUsers;
        Assert.Equal(400,f.Patch("policy", "\"role\":\"Kid\"," + fields).Status);
        Assert.Equal(before,f.R.Policy.Configuration.ArrRequestUsers); Assert.Equal(0,f.Saves);
    }
    [Fact]
    public void StaleWritesAndFailedPersistenceNeverReportSuccessOrLoseCurrentConfig()
    {
        using var f = new Fixture(); var rev=f.Revision();
        Assert.Equal(200,f.Patch("policy","\"quotaLimit\":3",rev).Status);
        Assert.Equal(409,f.Patch("policy","\"quotaLimit\":9",rev).Status);
        var before=f.R.Policy.Configuration.ArrRequestUsers; f.FailSave=true;
        Assert.Equal(503,f.Patch("policy","\"quotaLimit\":8").Status);
        Assert.Equal(before,f.R.Policy.Configuration.ArrRequestUsers);
    }
    [Fact]
    public void DisplayPatchPreservesAllConsentsAndUnknownFieldsAndUsesWholeFileRevision()
    {
        using var f = new Fixture(); var id=f.R.Member.ToString("N");
        var path=f.Files.Write(id,"{\"AutoSeasonRequests\":false,\"AutoMovieRequests\":true,\"ListSwapIn\":false,\"FuturePreference\":7,\"ShowFileSizes\":false}");
        var rev=f.Revision("display");
        Assert.Equal(200,f.Patch("display","\"acquisitionBadges\":false,\"listStatus\":null",rev).Status);
        var stored=JsonDocument.Parse(File.ReadAllText(path)).RootElement;
        Assert.False(stored.GetProperty("AutoSeasonRequests").GetBoolean()); Assert.True(stored.GetProperty("AutoMovieRequests").GetBoolean());
        Assert.False(stored.GetProperty("ListSwapIn").GetBoolean()); Assert.Equal(7,stored.GetProperty("FuturePreference").GetInt32());
        Assert.Equal(409,f.Patch("display","\"listStatus\":false",rev).Status);
        foreach(var banned in new[]{"autoSeasonRequests","autoMovieRequests","listSwapIn","emailVerified","showFileSizes"})
            Assert.Equal(400,f.Patch("display","\""+banned+"\":true").Status);
    }
    [Fact]
    public void CorruptSettingsAreUnavailableAndNeverReplacedOrQuarantined()
    {
        using var f = new Fixture(); var path=f.Files.Write(f.R.Member.ToString("N"),"broken");
        Assert.False(f.Read().GetProperty("display").GetProperty("available").GetBoolean());
        Assert.Equal(503,f.Service.Patch(f.R.Admin,f.R.Member,"display",JsonDocument.Parse("{\"revision\":\"x\",\"listStatus\":false}").RootElement).Status);
        Assert.Equal("broken",File.ReadAllText(path)); Assert.Single(Directory.GetFiles(Path.GetDirectoryName(path)!));
    }
    [Fact]
    public void PoolMembershipOnlyChangesThisPersonAndCanRevealRoleFallback()
    {
        using var f = new Fixture(); var c=f.R.Policy.Configuration;
        var personal=f.Files.Write(f.R.Member.ToString("N"),"{\"AutoSeasonRequests\":false,\"AutoMovieRequests\":true,\"ListSwapIn\":null}");
        var consents=File.ReadAllText(personal);
        c.ArrGroupQuotaPools=JsonSerializer.Serialize(new[]{new GroupQuotaPool{Id="role",Name="Role",Limit=3,Roles=new[]{"Member"}},new GroupQuotaPool{Id="explicit",Name="Other",Limit=5,Users=new[]{f.R.Kid.ToString("N")}}});
        c.ArrGroupQuotaPools=c.ArrGroupQuotaPools.Replace("\"name\":\"Role\"", "\"name\":\" Role \"").Replace("\"limit\":3", "\"limit\":3,\"futurePoolField\":7");
        Assert.Equal(200,f.Patch("pool-membership","\"poolId\":\"explicit\"").Status);
        Assert.Equal(consents,File.ReadAllText(personal));
        Assert.Equal(" Role ",GroupQuotaPolicy.Parse(c.ArrGroupQuotaPools)[0].Name);
        Assert.Equal(7,JsonDocument.Parse(c.ArrGroupQuotaPools).RootElement[0].GetProperty("futurePoolField").GetInt32());
        Assert.Equal(new[]{f.R.Kid.ToString("N"),f.R.Member.ToString("N")},GroupQuotaPolicy.Parse(c.ArrGroupQuotaPools)[1].Users);
        Assert.Equal(200,f.Patch("pool-membership","\"poolId\":null").Status);
        Assert.Equal(consents,File.ReadAllText(personal));
        var pools=GroupQuotaPolicy.Parse(c.ArrGroupQuotaPools);
        Assert.Equal("role",GroupQuotaPolicy.For(pools,f.R.Member,"Member",7)!.Id);
        Assert.Equal(new[]{f.R.Kid.ToString("N")},pools[1].Users);
    }
    [Fact]
    public void DatabaseOutageIsUnknownInsteadOfZeroAndConfigEditsStillWork()
    {
        using var f = new Fixture(); typeof(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.AcquireDatabase).GetField("_unavailable",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!.SetValue(f.R.Db,"offline");
        Assert.Equal(JsonValueKind.Null,f.Read().GetProperty("usage").GetProperty("pending").ValueKind);
        Assert.Equal(JsonValueKind.Null,f.Read().GetProperty("consents").GetProperty("eligible").ValueKind);
        Assert.Equal(200,f.Patch("policy","\"quotaLimit\":5").Status);
    }
    [Fact]
    public void SeerrImportIsNarrowAndDoesNotChangeOtherPeople()
    {
        using var f = new Fixture(); var c=f.R.Policy.Configuration; c.JellyseerrImportBlockedUsers=f.R.Kid.ToString("N");
        Assert.Equal(200,f.Patch("seerr-import","\"blocked\":true").Status);
        Assert.Contains(f.R.Kid.ToString("N"),c.JellyseerrImportBlockedUsers); Assert.Contains(f.R.Member.ToString("N"),c.JellyseerrImportBlockedUsers);
        Assert.Equal(200,f.Patch("seerr-import","\"blocked\":false").Status); Assert.DoesNotContain(f.R.Member.ToString("N"),c.JellyseerrImportBlockedUsers);
    }
    [Fact]
    public void ProductionPolicyUsesInheritedDefaultsTrustedGatesAndStoredOverrides()
    {
        using var r = new IntegrationHouseholdRulesTests.Rules(); using var files = new CoreFixture();
        ((User)r.Admin.Handle!).SetPermission(PermissionKind.IsAdministrator, true);
        var users = new Mock<IUserManager>();
        users.Setup(x=>x.GetUserById(It.IsAny<Guid>())).Returns((Guid id)=>r.View.Users.TryGetValue(id,out var v)?(User)v.Handle!:null);
        var service = new AdminUserSettingsService(r.Service, users.Object, files.Manager, r.Rig.Audit, _=>{});
        JsonElement Read() => Json(service.Read(r.Member.UserId).Body);
        AdminUserResult Patch(string fields) => service.Patch(r.Admin.UserId,r.Member.UserId,"policy",JsonDocument.Parse("{\"revision\":\""+Read().GetProperty("revisions").GetProperty("policy").GetString()+"\","+fields+"}").RootElement);
        Assert.Equal(200,Patch("\"role\":\"Trusted\",\"quotaLimit\":2,\"quotaGb\":10").Status);
        Assert.Equal("trusted",Read().GetProperty("policy").GetProperty("effective").GetProperty("role").GetString());
        Assert.Equal(JsonValueKind.Null,Read().GetProperty("policy").GetProperty("limit").ValueKind);
        r.Config.ArrPhase4HouseholdRulesEnabled=false;
        Assert.Equal("member",Read().GetProperty("policy").GetProperty("effective").GetProperty("role").GetString());
        Assert.Equal(2,Read().GetProperty("policy").GetProperty("limit").GetInt32());
        Assert.Equal(10,Read().GetProperty("policy").GetProperty("gbLimit").GetDouble());
        Assert.Equal(400,Patch("\"role\":\"Trusted\"").Status);
    }
    [Fact]
    public void SeerrOwnsQuotaAndRightsWhileJeRoleCanStillBeChanged()
    {
        using var f=new Fixture(); f.R.Policy.Configuration.ArrRequestBackend="seerr";
        Assert.Equal(409,f.Patch("policy","\"quotaLimit\":3").Status);
        Assert.Equal(200,f.Patch("policy","\"role\":\"Kid\"").Status);
        Assert.Equal("seerr",f.Read().GetProperty("seerr").GetProperty("quotaSource").GetString());
    }
    [Fact]
    public void EveryAdministratorGroupKeepsAllPersonalConsentsByteForByte()
    {
        using var f=new Fixture(); var path=f.Files.Write(f.R.Member.ToString("N"),"{\"AutoSeasonRequests\":false,\"AutoMovieRequests\":true,\"ListSwapIn\":null}");
        var original=File.ReadAllText(path);
        Assert.Equal(200,f.Patch("policy","\"role\":\"Kid\"").Status);
        Assert.Equal(original,File.ReadAllText(path));
        Assert.Equal(200,f.Patch("seerr-import","\"blocked\":true").Status);
        Assert.Equal(original,File.ReadAllText(path));
        Assert.Equal(200,f.Patch("display","\"listStatus\":false").Status);
        var stored=JsonDocument.Parse(File.ReadAllText(path)).RootElement;
        Assert.False(stored.GetProperty("AutoSeasonRequests").GetBoolean());Assert.True(stored.GetProperty("AutoMovieRequests").GetBoolean());
        Assert.Equal(JsonValueKind.Null,stored.GetProperty("ListSwapIn").ValueKind);
        var audits=f.R.Audit.ReadRecent(10);Assert.Equal(3,audits.Count);
        Assert.All(audits,a=>{Assert.Equal(f.R.Admin.ToString("N"),a.UserId);Assert.Equal(f.R.Member.ToString("N"),a.Target);Assert.DoesNotContain("Consent",a.Details!["fields"]);});
    }
    [Fact]
    public void AConcurrentHouseholdEditInvalidatesThePolicyRevision()
    {
        using var f=new Fixture(); var revision=f.Revision();f.R.Policy.Configuration.ArrRequestQuotaLimit=6;
        Assert.Equal(409,f.Patch("policy","\"quotaLimit\":3",revision).Status);
        Assert.Equal(6,f.R.Policy.Configuration.ArrRequestQuotaLimit);
    }

    [Fact]
    public async Task HttpSerializationKeepsNullInheritanceAndUnknownValuesExplicit()
    {
        using var f=new Fixture();
        var result=Assert.IsType<ObjectResult>(await f.As().GetUser(f.R.Member.ToString()));
        var json=JsonSerializer.SerializeToElement(result.Value,new JsonSerializerOptions(JsonSerializerDefaults.Web){DefaultIgnoreCondition=System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull});
        Assert.Equal(JsonValueKind.Null,json.GetProperty("pools").GetProperty("explicit").ValueKind);
        Assert.Equal(JsonValueKind.Null,json.GetProperty("policy").GetProperty("stored").GetProperty("fourKInstances").ValueKind);
    }
    [Theory]
    [InlineData("{\"QuotaLimit\":true}")][InlineData("{\"FourKInstances\":false}")]
    public void MalformedStoredOverridesAreUnavailableAndNeverReplaced(string entry)
    {
        using var f=new Fixture();f.R.Policy.Configuration.ArrRequestUsers="{\""+f.R.Member.ToString("N")+"\":"+entry+"}";
        Assert.False(f.Read().GetProperty("policy").GetProperty("available").GetBoolean());
        var before=f.R.Policy.Configuration.ArrRequestUsers;
        var answer=f.Service.Patch(f.R.Admin,f.R.Member,"policy",JsonDocument.Parse("{\"revision\":\"x\",\"role\":\"Kid\"}").RootElement);
        Assert.Equal(503,answer.Status);Assert.Equal(before,f.R.Policy.Configuration.ArrRequestUsers);
    }

    [Fact]
    public void UnreadablePolicyNeverProducesAnAuthoritativeDefaultRoleOrQuotaInTheBatch()
    {
        using var f=new Fixture();f.R.Policy.People[f.R.Member]=f.R.Policy.People[f.R.Member] with {Pool=new GroupPoolBinding("role","Role",4,7)};f.R.Policy.Configuration.ArrRequestUsers="broken";
        var batch=Json(f.Service.Summary().Body);var row=batch.GetProperty("people").EnumerateArray().Single(p=>p.GetProperty("id").GetString()==f.R.Member.ToString("N"));
        Assert.Equal(JsonValueKind.Null,row.GetProperty("role").ValueKind);
        Assert.Equal(JsonValueKind.Null,row.GetProperty("usage").GetProperty("quota").ValueKind);
        Assert.Equal(JsonValueKind.Null,f.Read().GetProperty("policy").GetProperty("limit").ValueKind);
        Assert.Equal(JsonValueKind.Null,f.Read().GetProperty("pools").GetProperty("effective").ValueKind);
    }

    [Fact]
    public void NativeStampEffectiveDisplayHonorsThePersonsOverallPosterOptOut()
    {
        using var f=new Fixture();var c=f.R.Policy.Configuration;
        c.ArrPhase4Enabled=true;c.ArrPhase4AcquisitionBadgesEnabled=true;c.ArrPhase4NativeStampsEnabled=true;c.NativePosterTagsEnabled=true;
        f.Files.Write(f.R.Member.ToString("N"),"{\"UseNativePosterTags\":false,\"NativeAcquisitionStamps\":true}");
        var display=f.Read().GetProperty("display");
        Assert.True(display.GetProperty("gates").GetProperty("nativeAcquisitionStamps").GetBoolean());
        Assert.False(display.GetProperty("effective").GetProperty("nativeAcquisitionStamps").GetBoolean());
        Assert.True(display.GetProperty("effective").GetProperty("acquisitionBadges").GetBoolean());
    }

    [Fact]
    public void MissingPersonalStoreIsUnavailableAndNeverRecreatedByAReadOrPatch()
    {
        using var f=new Fixture();var root=f.Files.ConfigRoot;Directory.Move(root,root+".offline");
        try {
            Assert.False(f.Read().GetProperty("display").GetProperty("available").GetBoolean());
            Assert.False(Directory.Exists(root));
            Assert.Equal(503,f.Service.Patch(f.R.Admin,f.R.Member,"display",JsonDocument.Parse("{\"revision\":\"x\",\"listStatus\":false}").RootElement).Status);
            Assert.False(Directory.Exists(root));
        } finally { if(Directory.Exists(root))Directory.Delete(root,true);Directory.Move(root+".offline",root); }
    }

    [Fact]
    public async Task AdministratorSeerrReadsDoNotWakeRequestsOrConsumeTheNextNormalLinkWake()
    {
        using var lab=new IntegrationRequestBackendsTests.SeerrLab();var woken=0;
        var backend=new SeerrBackend(lab.Seerr.Transport,lab.Model,null,()=>lab.Config,()=>lab.Now,linked:_=>woken++);
        await backend.PrepareAdminReadAsync(lab.User,default);await backend.PrepareAdminReadAsync(lab.User,default);
        Assert.Equal(0,woken);Assert.Empty(lab.Seerr.Transport.Writes);
        await backend.PrepareAsync(lab.User,IntegrationRequestLedgerTests.Movie(),default);
        Assert.Equal(1,woken);
        await backend.PrepareAsync(lab.User,IntegrationRequestLedgerTests.Movie(),default);
        Assert.Equal(1,woken);
    }

    [Fact]
    public void FirstAdministratorDisplayWriteKeepsTheSameOtherDefaultsAsThePersonsFirstRead()
    {
        using var f=new Fixture();var c=f.R.Policy.Configuration;c.AutoPauseEnabled=true;c.DefaultSubtitleSize=3;c.WatchProgressDefaultMode="time";
        Assert.Equal(200,f.Patch("display","\"acquisitionBadges\":false").Status);
        var stored=f.Files.Manager.GetUserConfiguration<Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserSettings>(f.R.Member.ToString("N"),"settings.json");
        Assert.True(stored.AutoPauseEnabled);Assert.Equal(3,stored.SelectedFontSizePresetIndex);Assert.Equal("time",stored.WatchProgressMode);
        Assert.Null(stored.AutoSeasonRequests);Assert.Null(stored.AutoMovieRequests);Assert.Null(stored.ListSwapIn);
    }
    [Fact]
    public void ResetUsesTheSameConfiguredProgressDefaultAsFirstReadAndKeepsConsent()
    {
        using var f=new ApiPluginFixture();f.Plugin.Configuration.WatchProgressDefaultMode="time";var id=Guid.NewGuid().ToString("N");
        f.Core.Manager.SaveUserConfiguration(id,"settings.json",new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserSettings{WatchProgressMode="percentage",ListSwapIn=true,AutoMovieRequests=false});
        var controller=ApiAssetTests.Controller(f.Core,f.Core.Manager);controller.HttpContext.User=TestCallers.Principal(Guid.NewGuid(),true);
        Assert.IsType<OkObjectResult>(controller.ResetAllUsersSettings());
        var stored=f.Core.Manager.GetUserConfiguration<Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserSettings>(id,"settings.json");
        Assert.Equal("time",stored.WatchProgressMode);Assert.True(stored.ListSwapIn);Assert.False(stored.AutoMovieRequests);
    }

}
