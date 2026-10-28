using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Home;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using MediaBrowser.Controller.Library;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Users;

/// <summary>A group response; unavailable components remain explicit rather than becoming defaults.</summary>
public sealed record AdminUserResult(int Status, object Body);

/// <summary>Native Dashboard user settings over the existing household policy, personal files and ledger.</summary>
public sealed class AdminUserSettingsService
{
    private readonly RequestService _requests;
    private readonly IUserManager _users;
    private readonly UserConfigurationManager _files;
    private readonly ArrAuditLog _audit;
    private readonly Action<PluginConfiguration> _save;
    private readonly ListStore? _lists;
    private readonly SeerrBackend? _seerr;
    private readonly Ready.ReadyPlaylistService? _ready;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly string[] DisplayFields = { "listPlaceholders", "listStatus", "acquisitionBadges", "nativeAcquisitionStamps", "useNativePosterTags",
        // Q-REBUILD1-3 (b), D43: 4c3's list-page and 4d's home-row preferences (append-only; same tri-state rule).
        "listPlaylistUi", "listCollectionUi", "homeRowRequests", "homeRowSoon", "homeRowArrived" };

    /// <summary>Creates the administrator adapter (DI); no user data is loaded or seeded.</summary>
    public AdminUserSettingsService(RequestService requests, IUserManager users, UserConfigurationManager files, ArrAuditLog audit, ListStore lists, SeerrBackend seerr, Ready.ReadyPlaylistService ready)
        : this(requests, users, files, audit, _ => JellyfinEnhanced.Instance!.SaveConfiguration(), lists, seerr, ready) { }

    internal AdminUserSettingsService(RequestService requests, IUserManager users, UserConfigurationManager files, ArrAuditLog audit, Action<PluginConfiguration> save, ListStore? lists = null, SeerrBackend? seerr = null, Ready.ReadyPlaylistService? ready = null)
    { _requests=requests; _users=users; _files=files; _audit=audit; _save=save; _lists=lists; _seerr=seerr; _ready=ready; }

    // Phase 4f (D43): the person's Ready playlist and native-message consents with their switches, read-only. Administrators
    // never consent for a person; read before the settings locks (it reads Jellyfin's playlist).
    private object ReadyBlock(Guid id, PluginConfiguration c)
    {
        var messagesGate = Ready.ReadyFlags.Messages(c);
        bool? messages = null;
        if (_requests.Ledger.Database.Available) try { messages = new NotifyStore(_requests.Ledger.Database).Prefs(id).NativeReadyMessages; } catch (Exception) { messages = null; }
        Ready.ReadyStatus? playlist = null;
        if (_ready != null) try { playlist = _ready.Status(id); } catch (Exception) { playlist = null; }
        return new {
            available = playlist != null,
            playlistGate = Ready.ReadyFlags.Playlist(c), playlistStored = playlist?.OptedIn, playlistEffective = playlist != null && playlist.Enabled && playlist.OptedIn && playlist.State == Ready.ReadyState.Active,
            state = playlist?.State, reason = playlist?.Reason, entries = playlist?.Entries, retentionDays = Ready.ReadyFlags.RetentionDays(c),
            messagesGate, messagesStored = messages, messagesEffective = messagesGate && messages == true,
        };
    }

    private PluginConfiguration Config => _requests.Policy.Configuration;
    private static AdminUserResult Error(int status,string reason) => new(status,new {reason});
    private static string Hash(string value) => MutationInput.Hash(value);
    private static JObject Object(string? raw) => raw == null ? new() : JObject.Parse(raw, new Newtonsoft.Json.Linq.JsonLoadSettings { DuplicatePropertyNameHandling=DuplicatePropertyNameHandling.Error });
    private static JObject Map(string? raw) => Object(string.IsNullOrWhiteSpace(raw) ? "{}" : raw);
    private static string Raw(JToken value) => value.ToString(Newtonsoft.Json.Formatting.None);
    private static JsonElement Wire(object value) => JsonSerializer.SerializeToElement(value,Json);
    private static JProperty? Property(JObject doc,string name) => doc.Properties().SingleOrDefault(p=>string.Equals(p.Name,name,StringComparison.OrdinalIgnoreCase));
    private static JToken? Value(JObject doc,string name) => Property(doc,name)?.Value;
    private static bool? Preference(JObject doc,string name) => Value(doc,name) is { Type:JTokenType.Boolean } v ? v.Value<bool>() : null;
    private static JObject UserEntry(JObject map,Guid id)
    {
        var matches=map.Properties().Where(p=>Guid.TryParse(p.Name,out var g)&&g==id).ToArray();
        if(matches.Length>1) throw new InvalidDataException("Ambiguous user overrides");
        if(matches.Length==0) return new();
        return matches[0].Value as JObject ?? throw new InvalidDataException("Invalid user overrides");
    }
    private static JObject SettingsDocument(string? raw)
    {
        var doc = Object(raw);
        if (doc.Properties().Select(p => p.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count() != doc.Count) throw new InvalidDataException("Ambiguous preferences");
        foreach (var key in DisplayFields.Concat(new[] { "autoSeasonRequests", "autoMovieRequests", "listSwapIn" }))
            if (Value(doc, key) is {} value && value.Type is not (JTokenType.Null or JTokenType.Boolean)) throw new InvalidDataException("Invalid preference");
        return doc;
    }
    private static void ValidatePolicy(JObject map)
    {
        foreach (var property in map.Properties())
        {
            if (property.Value is not JObject entry) throw new InvalidDataException("Invalid policy entry");
            if (entry.Properties().Select(p => p.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count() != entry.Count) throw new InvalidDataException("Ambiguous policy fields");
            foreach (var field in entry.Properties())
            {
                var value = field.Value;
                if (value.Type == JTokenType.Null) continue;
                switch (field.Name.ToLowerInvariant())
                {
                    case "role": if (value.Type != JTokenType.String || !HouseholdService.RulesRoles.Contains(value.Value<string>(), StringComparer.Ordinal)) throw new InvalidDataException("Invalid role"); break;
                    case "quotalimit": if (value.Type != JTokenType.Integer || value.Value<long>() < -1 || value.Value<long>() > 10000) throw new InvalidDataException("Invalid count"); break;
                    case "quotagb": if (value.Type is not (JTokenType.Integer or JTokenType.Float) || !double.IsFinite(value.Value<double>()) || value.Value<double>() < 0) throw new InvalidDataException("Invalid GB cap"); break;
                    case "fourkinstances": if (value is not JArray array || array.Any(v => v.Type != JTokenType.String)) throw new InvalidDataException("Invalid grants"); break;
                }
            }
        }
    }
    private static string ConfigRevision(PluginConfiguration c,string group) => Hash(group+":"+ (group switch {
        "pool-membership" => c.ArrGroupQuotaPools,
        "seerr-import" => c.JellyseerrImportBlockedUsers,
        _ => JsonSerializer.Serialize(c,Json),
    }));

    /// <summary>Refreshes Seerr identity with read-only transport, then projects current target settings.</summary>
    public async Task<AdminUserResult> ReadAsync(Guid id, CancellationToken ct)
    {
        if (ArrCaller.Find(id, _users) == null) return Error(404, "unknown_user");
        if (Config.ArrRequestBackend == "seerr" && _seerr != null) await _seerr.PrepareAdminReadAsync(id, ct).ConfigureAwait(false);
        return Read(id);
    }

    /// <summary>Reads one person, including disabled accounts, without importing a Seerr account or seeding files.</summary>
    public AdminUserResult Read(Guid id)
        => Read(id, null);

    // Successful patches include the baselines captured inside their write lock, so the client can distinguish
    // dependent revision advances from changes made by another editor between this Save's requests.
    private AdminUserResult Read(Guid id, IReadOnlyDictionary<string,string>? previousRevisions)
    {
        var person=ArrCaller.Find(id,_users);
        if(person==null) return Error(404,"unknown_user");
        var ready=ReadyBlock(id,Config);
        lock(JellyfinEnhanced.AnalyticsCredentialLock)
        lock(_files.UserSettingsLock(id.ToString("N")))
        {
            var c=Config;
            JObject? doc=null; string? file=null; bool fileAvailable=true;
            try { file=_files.ReadExistingSettingsDocument(id); doc=SettingsDocument(file); }
            catch(Exception) { fileAvailable=false; }
            JObject? entry=null; bool policyAvailable=true;
            try { var map=Map(c.ArrRequestUsers); ValidatePolicy(map); ValidatePolicy(Map(c.ArrRequestRoles)); if(c.IsSonarrInstancesCorrupt()||c.IsRadarrInstancesCorrupt()) throw new InvalidDataException("Unavailable instances"); entry=UserEntry(map,id); }
            catch(Exception) { policyAvailable=false; entry=null; }
            var facts=_requests.Identity(id);
            var caps=_requests.Me(id);
            var usage=Usage(id,policyAvailable);
            var grants=Instances(c);
            var pool=Pools(c,id);
            var gates=new Dictionary<string,bool> {
                ["listPlaceholders"]=ListFlags.Lists(c), ["listStatus"]=ListFlags.Status(c),
                ["acquisitionBadges"]=AcquisitionStampFlags.Badges(c), ["nativeAcquisitionStamps"]=AcquisitionStampFlags.NativeStamps(c),
                ["useNativePosterTags"]=c.NativePosterTagsEnabled,
                ["listPlaylistUi"]=ListFlags.PlaylistUi(c), ["listCollectionUi"]=ListFlags.CollectionUi(c),
                ["homeRowRequests"]=HomeFlags.Rows(c), ["homeRowSoon"]=HomeFlags.Rows(c), ["homeRowArrived"]=HomeFlags.Rows(c),
            };
            var storedDisplay=DisplayFields.ToDictionary(k=>k,k=>doc==null?(bool?)null:Preference(doc,k));
            var effectiveDisplay=fileAvailable?gates.ToDictionary(p=>p.Key,p=>p.Value&&storedDisplay[p.Key]!=false):null;
            if(effectiveDisplay!=null) effectiveDisplay["nativeAcquisitionStamps"]=Services.PosterTags.PosterTagSettings.FromUserSettings(new JellyfinEnhancedUserSettings {UseNativePosterTags=storedDisplay["useNativePosterTags"],NativeAcquisitionStamps=storedDisplay["nativeAcquisitionStamps"]},c).AcquisitionStampsEnabled;
            var storedPolicy=entry==null?null:new {
                role=Value(entry,"role")?.Value<string>(),quotaLimit=(int?)Value(entry,"quotaLimit"),quotaGb=(double?)Value(entry,"quotaGb"),
                fourKInstances=Value(entry,"fourKInstances") is JArray a?a.Values<string>().ToArray():null,
            };
            object? notifications=null; object? grant=null; bool grantAvailable=false;
            if(_requests.Ledger.Database.Available) try {
                var prefs=new NotifyStore(_requests.Ledger.Database).Prefs(id);
                notifications=new { available=true, ntfy=prefs.Ntfy, topic=prefs.NtfyTopic, assigned=prefs.NtfyTopicByAdmin,
                    emailVerified=!string.IsNullOrEmpty(prefs.EmailAddress),emailEnabled=prefs.Email, quietHours=prefs.QuietHours, quietFrom=prefs.QuietFrom, quietTo=prefs.QuietTo,hideTitles=prefs.HideTitles };
                grant=new AutomationStore(_requests.Ledger.Database).Grants().FirstOrDefault(g=>Guid.TryParse(g.UserId,out var u)&&u==id);
                grantAvailable=true;
            } catch(Exception) { /* independent DB component is unavailable */ }
            var consents=new Dictionary<string,bool?> {
                ["autoSeasonRequests"]=doc==null?null:Preference(doc,"autoSeasonRequests"), ["autoMovieRequests"]=doc==null?null:Preference(doc,"autoMovieRequests"),
                ["listSwapIn"]=doc==null?null:Preference(doc,"listSwapIn"),
            };
            var blocked=JellyseerrUserImportHelper.GetBlockedUserIds(c.JellyseerrImportBlockedUsers).Contains(id.ToString("N"));
            return new(200,new {
                id=id.ToString("N"),name=person.Username,disabled=person.HasPermission(PermissionKind.IsDisabled),jellyfinAdmin=person.HasPermission(PermissionKind.IsAdministrator),
                revisions=new Dictionary<string,string?> {
                    ["policy"]=policyAvailable?ConfigRevision(c,"policy"):null,["display"]=fileAvailable?Hash(file??"absent"):null,
                    ["pool-membership"]=pool.Available?ConfigRevision(c,"pool-membership"):null,["seerr-import"]=ConfigRevision(c,"seerr-import"),
                },
                previousRevisions,
                policy=new {available=policyAvailable,stored=storedPolicy,effective=policyAvailable?caps:null,backend=c.ArrRequestBackend,roles=HouseholdService.RolesFor(c),
                    sources=new { role=storedPolicy?.role!=null?"person":"household",count=Source(entry,c.ArrRequestRoles,facts.Role,"quotaLimit"),gb=Source(entry,c.ArrRequestRoles,facts.Role,"quotaGb"),fourK=Source(entry,c.ArrRequestRoles,facts.Role,"fourKInstances") },
                    limit=policyAvailable?facts.Limit:null,gbLimit=policyAvailable?(double?)facts.GbLimit:null,windowDays=facts.WindowDays,fourKMoviesReason=FourKReason(id,true),fourKSeriesReason=FourKReason(id,false),instances=grants },
                usage, pools=new { available=pool.Available,choices=pool.Choices,@explicit=pool.Explicit,effective=policyAvailable?facts.Pool:null,poolUse=policyAvailable?PoolUsage(id):null },
                display=new { available=fileAvailable,stored=fileAvailable?storedDisplay:null,gates,effective=effectiveDisplay },
                notifications=notifications??new {available=false},
                consents=new { available=fileAvailable,person=id.ToString("N"),stored=fileAvailable?consents:null,grant,grantAvailable,
                    eligible=person.HasPermission(PermissionKind.IsAdministrator)||(policyAvailable&&facts.Role=="Trusted")||grant!=null ? (bool?)true : grantAvailable&&policyAvailable ? false : null,
                    recipes=AutomationRecipes.All.Select(r=>new {recipe=r,control=Control(c,r),preference=consents.GetValueOrDefault(r==AutomationRecipes.AutoSeason?"autoSeasonRequests":r==AutomationRecipes.AutoMovie?"autoMovieRequests":""),legacy=AutomationRecipes.IsLegacy(r)}).ToArray(),lists=ListSummary(id) },
                seerr=new { enabled=Backends.EffectiveRequestsBackend.SeerrUsable(c),blocked,autoImport=c.JellyseerrAutoImportUsers,account=facts.SeerrUser,permissions=facts.SeerrPermissions,
                    adminUrl=SeerrAdminUrl(c),state=blocked?"blocked":facts.SeerrUser!=null?"linked":facts.SeerrUnlinked?"unlinked":"unavailable",quotaSource=c.ArrRequestBackend=="seerr"?"seerr":"je" },
                safety=new { parentalLimit=person.MaxParentalRatingScore,role=facts.Role,alwaysApproval=facts.Role=="Kid",rules=HouseholdRules.Parse(c.ArrHouseholdRules),rulesEnabled=HouseholdFlags.RulesApply(c) },
                ready,
            });
        }
    }
    private static string? SeerrAdminUrl(PluginConfiguration c)
    {
        var candidate = (c.JellyseerrUrls ?? string.Empty).Split(new[] { ',', ';', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim();
        return Uri.TryCreate(candidate, UriKind.Absolute, out var url) && url.Scheme is "http" or "https" && string.IsNullOrEmpty(url.UserInfo) ? url.AbsoluteUri.TrimEnd('/') + "/users" : null;
    }
    private static object Control(PluginConfiguration c, string recipe)
    {
        var control = AutomationFlags.Control(c, recipe);
        return new { stored = control.Stored?.ToString().ToLowerInvariant(), effective = control.Effective?.ToString().ToLowerInvariant(), control.Reason, control.Engine, control.Legacy };
    }
    private string? FourKReason(Guid id,bool movie)
    {
        var facts = _requests.Policy.Evaluate(id,movie?new MutationInput{Key="movie:tmdb:1",Variant="4k"}:new MutationInput{Key="tv:tvdb:1",Scope="seasons",Seasons=new[]{1},Variant="4k"});
        return facts.Refusal ?? (facts.Can4k ? null : "requests_4k_required");
    }
    private static string Source(JObject? entry,string roles,string role,string field)
    {
        if(entry!=null && Value(entry,field) is { Type:not JTokenType.Null }) return "person";
        try { var map=Map(roles); if(map[role] is JObject r && Value(r,field) is { Type:not JTokenType.Null }) return "role"; }catch(Exception) { return "unavailable"; }
        return "household";
    }
    private object Usage(Guid id,bool policyAvailable=true)
    {
        try {
            if(!_requests.Ledger.Database.Available) throw new InvalidOperationException();
            var pending=_requests.Ledger.List(id,false).Count(w=>w.Status=="pending");
            var quota=_requests.Quota(id); var tv=_requests.Quota(id,false);
            return new {available=true,pending=(int?)pending,quota=policyAvailable&&quota.Available?quota:null,tvQuota=policyAvailable&&tv.Available?tv:null};
        }catch(Exception) { return new {available=false,pending=(int?)null,quota=(object?)null,tvQuota=(object?)null}; }
    }
    private object? PoolUsage(Guid id) { try { return _requests.Ledger.Database.Available && _requests.Pool(id) is {} p ? new {pool=p.Pool,quota=p.Use}:null; }catch(Exception) {return null;} }
    private object ListSummary(Guid id)
    {
        if(_lists==null) return new {available=false};
        try {
            var docs=_lists.EnumerateListIds().Take(2001).Select(k=>_lists.ReadForAdmin(k)).ToList();
            return new { available=true,truncated=docs.Count>2000,items=docs.Take(2000).Where(d=>Guid.TryParse(d.SwapIn?.ByUserId,out var u)&&u==id||Guid.TryParse(d.Source?.LinkedByUserId,out var l)&&l==id)
                .Select(d=>new {id=d.ListId,consentedBy=d.SwapIn?.ByUserId,consentedAt=d.SwapIn?.At,linkedBy=d.Source?.LinkedByUserId,sync=d.Source?.SyncEnabled}).ToArray() };
        } catch(Exception) {return new {available=false};}
    }
    private static object[] Instances(PluginConfiguration c) => c.GetSonarrInstances().Concat(c.GetRadarrInstances()).Where(i=>i.Role=="4k"&&!i.Retired).Select(i=>(object)new {id=i.Id,name=i.Name,enabled=i.Enabled}).ToArray();
    private sealed record PoolRead(bool Available,IReadOnlyList<GroupQuotaPool> Choices,string? Explicit);
    private static PoolRead Pools(PluginConfiguration c,Guid id)
    {
        try {
            var pools=JsonSerializer.Deserialize<List<GroupQuotaPool>>(string.IsNullOrWhiteSpace(c.ArrGroupQuotaPools)?"[]":c.ArrGroupQuotaPools,Json)??throw new InvalidDataException();
            if(GroupQuotaPolicy.Validate(pools)!=null) throw new InvalidDataException();
            return new(true,pools,pools.FirstOrDefault(p=>p.Users.Any(u=>Guid.TryParse(u,out var g)&&g==id))?.Id);
        }catch(Exception) { return new(false,Array.Empty<GroupQuotaPool>(),null); }
    }

    /// <summary>One bounded summary request for all visible cards; no titles or metadata fetches.</summary>
    public AdminUserResult Summary(int offset=0,int limit=500)
    {
        if(offset<0||limit<1||limit>500) return Error(400,"invalid_page");
        var people=_users.GetAllUsers().Where(u=>u.Id!=Guid.Empty).OrderBy(u=>u.Id).Skip(offset).Take(limit+1).ToList();
        var policyAvailable = true;
        try { ValidatePolicy(Map(Config.ArrRequestUsers)); ValidatePolicy(Map(Config.ArrRequestRoles)); } catch (Exception) { policyAvailable = false; }
        var pending = new Dictionary<Guid,int>();
        var charges = new Dictionary<Guid,List<QuotaCharge>>();
        var available = _requests.Ledger.Database.Available;
        var ids = people.Take(limit).Select(p => p.Id).ToHashSet();
        var now = DateTimeOffset.UtcNow;
        if (available) try {
            _requests.Ledger.Database.Read(connection => {
                using (var cmd = connection.CreateCommand()) {
                    cmd.CommandText = "SELECT user_id,COUNT(*) FROM wants WHERE status='pending' AND " + Requests.RequestLedger.NotStaged + " GROUP BY user_id";
                    using var rows = cmd.ExecuteReader();
                    while (rows.Read()) if (Guid.TryParse(rows.GetString(0), out var id) && ids.Contains(id)) pending[id] = rows.GetInt32(1);
                }
                using (var cmd = connection.CreateCommand()) {
                    cmd.CommandText = "SELECT user_id,cost,charged_at,estimated_gb FROM reservations WHERE state='charged' AND charged_at>$since AND charged_at<=$now";
                    cmd.Parameters.AddWithValue("$since", now.AddDays(-365).ToUnixTimeMilliseconds());
                    cmd.Parameters.AddWithValue("$now", now.ToUnixTimeMilliseconds());
                    using var rows = cmd.ExecuteReader();
                    while (rows.Read()) if (Guid.TryParse(rows.GetString(0), out var id) && ids.Contains(id)) {
                        if (!charges.TryGetValue(id, out var list)) charges[id] = list = new();
                        list.Add(new(rows.GetInt32(1), DateTimeOffset.FromUnixTimeMilliseconds(rows.GetInt64(2)), rows.GetDouble(3)));
                    }
                }
                return true;
            });
        } catch (Exception) { available = false; }
        return new(200,new {people=people.Take(limit).Select(p=> {
            var facts = _requests.Identity(p.Id);
            var quota = facts.Backend == "seerr" ? facts.BackendQuota : available ? QuotaProjector.Project(charges.GetValueOrDefault(p.Id) ?? new(), facts.Limit, TimeSpan.FromDays(facts.WindowDays), now) : null;
            return new {id=p.Id.ToString("N"),role=policyAvailable?facts.Role.ToLowerInvariant():null,disabled=p.HasPermission(PermissionKind.IsDisabled),usage=new {available,pending=available?(int?)pending.GetValueOrDefault(p.Id):null,quota=policyAvailable&&quota?.Available==true?quota:null}};
        }).ToArray(),next=people.Count>limit?(int?)(offset+limit):null});
    }

    /// <summary>Validates the complete partial patch before any write; null removes an override, absence keeps it.</summary>
    public AdminUserResult Patch(Guid actor,Guid id,string group,JsonElement body)
    {
        if(ArrCaller.Find(actor,_users) is not { } admin||!admin.HasPermission(PermissionKind.IsAdministrator)||admin.HasPermission(PermissionKind.IsDisabled)) return Error(403,"admin_required");
        if(ArrCaller.Find(id,_users)==null) return Error(404,"unknown_user");
        var allow=group switch {"policy"=>new[]{"role","quotaLimit","quotaGb","fourKInstances"},"display"=>DisplayFields,"pool-membership"=>new[]{"poolId"},"seerr-import"=>new[]{"blocked"},_=>Array.Empty<string>()};
        if(body.ValueKind!=JsonValueKind.Object) return Error(400,"invalid_input");
        var fields=body.EnumerateObject().ToArray();
        if(fields.Length<2||fields.Select(p=>p.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count()!=fields.Length||fields.Any(p=>p.Name!="revision"&&!allow.Contains(p.Name))) return Error(400,"invalid_fields");
        if(!body.TryGetProperty("revision",out var rev)||rev.ValueKind!=JsonValueKind.String) return Error(400,"revision_required");
        lock(JellyfinEnhanced.AnalyticsCredentialLock)
        lock(_files.UserSettingsLock(id.ToString("N")))
        {
            // Recheck authority/target after lock contention too.
            if(ArrCaller.Find(actor,_users) is not {} current||current.HasPermission(PermissionKind.IsDisabled)||!current.HasPermission(PermissionKind.IsAdministrator)) return Error(403,"admin_required");
            if(ArrCaller.Find(id,_users)==null) return Error(404,"unknown_user");
            var c=Config;
            var previousRevisions=new Dictionary<string,string> { [group]=rev.GetString()! };
            if(group!="display") previousRevisions["policy"]=ConfigRevision(c,"policy");
            var auditId = Guid.NewGuid().ToString("N");
            bool Audit(string outcome) => _audit.Append(new ArrAuditEntry {Id=auditId,Time=DateTimeOffset.UtcNow,UserId=actor.ToString("N"),Action="users."+group,Tier=2,Target=id.ToString("N"),Outcome=outcome,Details=new Dictionary<string,string>{{"fields",string.Join(",",fields.Where(p=>p.Name!="revision").Select(p=>p.Name))}}});
            try {
                if(group=="policy") { ValidatePolicy(Map(c.ArrRequestUsers)); ValidatePolicy(Map(c.ArrRequestRoles)); if(c.IsSonarrInstancesCorrupt()||c.IsRadarrInstancesCorrupt()) return Error(503,"instances_unavailable"); }
                if(group=="pool-membership"&&!Pools(c,id).Available) return Error(503,"pools_unavailable");
                if(group=="display") {
                    var raw=_files.ReadExistingSettingsDocument(id);var doc=raw==null?JObject.FromObject(UserSettingsDefaults.Create(c)):SettingsDocument(raw);
                    if(rev.GetString()!=Hash(raw??"absent")) return Error(409,"revision_conflict");
                    foreach(var p in fields.Where(p=>p.Name!="revision")) {
                        if(p.Value.ValueKind is not (JsonValueKind.Null or JsonValueKind.True or JsonValueKind.False)) return Error(400,"invalid_display");
                    }
                    foreach(var p in fields.Where(p=>p.Name!="revision")) {var name=Property(doc,p.Name)?.Name??char.ToUpperInvariant(p.Name[0])+p.Name.Substring(1);doc[name]=JToken.Parse(p.Value.GetRawText());}
                    if(!Audit(ArrAuditLog.StartedOutcome)) return Error(503,"audit_unavailable");
                    _files.SaveUserConfiguration(id.ToString("N"),UserConfigurationManager.SettingsFileName,doc);
                } else {
                    if(rev.GetString()!=ConfigRevision(c,group)) return Error(409,"revision_conflict");
                    var old=group=="policy"?c.ArrRequestUsers:group=="pool-membership"?c.ArrGroupQuotaPools:c.JellyseerrImportBlockedUsers;
                    string next;
                    if(group=="policy") {
                        if(c.ArrRequestBackend!="je" && fields.Any(p=>p.Name is "quotaLimit" or "quotaGb" or "fourKInstances")) return Error(409,"backend_owned");
                        var map=Map(c.ArrRequestUsers);var entry=UserEntry(map,id);var updated=(JObject)entry.DeepClone();
                        foreach(var p in fields.Where(p=>p.Name!="revision")) {
                            if(p.Value.ValueKind!=JsonValueKind.Null) {
                                if(p.Name=="role"&&(p.Value.ValueKind!=JsonValueKind.String||!HouseholdService.RolesFor(c).Contains(p.Value.GetString(),StringComparer.Ordinal))) return Error(400,"invalid_role");
                                if(p.Name=="quotaLimit"&&(p.Value.ValueKind!=JsonValueKind.Number||!p.Value.TryGetInt32(out var n)||n< -1||n>10000)) return Error(400,"invalid_quota");
                                if(p.Name=="quotaGb"&&(p.Value.ValueKind!=JsonValueKind.Number||!p.Value.TryGetDouble(out var gb)||!double.IsFinite(gb)||gb<0||gb>1000000)) return Error(400,"invalid_gb");
                                if(p.Name=="fourKInstances") {
                                    if(p.Value.ValueKind!=JsonValueKind.Array||p.Value.GetArrayLength()>50) return Error(400,"invalid_grants");
                                    var instances=c.GetSonarrInstances().Concat(c.GetRadarrInstances()).Where(i=>i.Role=="4k"&&!i.Retired).Select(i=>i.Id).ToHashSet(StringComparer.Ordinal);
                                    if(p.Value.EnumerateArray().Any(v=>v.ValueKind!=JsonValueKind.String||!instances.Contains(v.GetString()!))) return Error(400,"invalid_grants");
                                }
                            }
                            if(ArrCaller.Find(id,_users)!.HasPermission(PermissionKind.IsAdministrator)&&p.Name=="role"&&p.Value.ValueKind!=JsonValueKind.Null) return Error(400,"admin_role_locked");
                            var name=Property(updated,p.Name)?.Name??char.ToUpperInvariant(p.Name[0])+p.Name.Substring(1);updated[name]=JToken.Parse(p.Value.GetRawText());
                        }
                        foreach(var alias in map.Properties().Where(p=>Guid.TryParse(p.Name,out var g)&&g==id).ToArray()) alias.Remove();
                        map[id.ToString("N")]=updated;next=Raw(map);
                    } else if(group=="pool-membership") {
                        var pools=Pools(c,id);if(!pools.Available) return Error(503,"pools_unavailable");
                        if(!body.TryGetProperty("poolId",out var value)||value.ValueKind is not (JsonValueKind.Null or JsonValueKind.String)) return Error(400,"invalid_pool");
                        var selected=value.ValueKind==JsonValueKind.Null?null:value.GetString();
                        if(selected!=null&&!pools.Choices.Any(p=>p.Id==selected)) return Error(400,"invalid_pool");
                        var edited=pools.Choices.Select(p=>p with {Users=p.Users.Where(u=>!Guid.TryParse(u,out var g)||g!=id).Concat(p.Id==selected?new[]{id.ToString("N")}:Array.Empty<string>()).ToArray()}).ToArray();
                        if(GroupQuotaPolicy.Validate(edited) is {} error) return Error(400,error);
                        var rawPools=JArray.Parse(string.IsNullOrWhiteSpace(c.ArrGroupQuotaPools)?"[]":c.ArrGroupQuotaPools);
                        for(var index=0;index<edited.Length;index++) {
                            var rawPool=(JObject)rawPools[index];
                            var name=Property(rawPool,"users")?.Name??"users";
                            rawPool[name]=new JArray(edited[index].Users);
                        }
                        next=Raw(rawPools);
                    } else {
                        if(!body.TryGetProperty("blocked",out var value)||value.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return Error(400,"invalid_blocked");
                        var blocked=JellyseerrUserImportHelper.GetBlockedUserIds(c.JellyseerrImportBlockedUsers).ToHashSet(StringComparer.OrdinalIgnoreCase);
                        if(value.GetBoolean()) blocked.Add(id.ToString("N"));else blocked.Remove(id.ToString("N"));
                        next=string.Join(",",blocked.OrderBy(x=>x,StringComparer.Ordinal));
                    }
                    void Assign(string v) {if(group=="policy")c.ArrRequestUsers=v;else if(group=="pool-membership")c.ArrGroupQuotaPools=v;else c.JellyseerrImportBlockedUsers=v;}
                    if(!Audit(ArrAuditLog.StartedOutcome)) return Error(503,"audit_unavailable");
                    Assign(next);try{_save(c);}catch(Exception){Assign(old);throw;}
                }
                Audit("succeeded");
                return Read(id,previousRevisions);
            } catch(Exception) {return Error(503,"settings_unavailable");}
        }
    }
}
