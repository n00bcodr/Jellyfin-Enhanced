using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>Per-user server-owned overrides. Missing fields retain preset behavior.</summary>
    public sealed record RequestUserSettings
    {
        /// <summary>Watcher, Kid, Member, Trusted (household rules on) or Manager. Administrator comes from Jellyfin.</summary>
        public string? Role { get; init; }
        /// <summary>Grant 4K on the listed instance ids only.</summary>
        public string[]? FourKInstances { get; init; }
        /// <summary>Optional rolling limit override, negative for unlimited.</summary>
        public int? QuotaLimit { get; init; }
        /// <summary>Optional estimated GB cap override.</summary>
        public double? QuotaGb { get; init; }
    }
    /// <summary>
    /// Current policy facts, evaluated again after every asynchronous prerequisite. <c>SeerrWholeSeries</c> (Seerr mode):
    /// Seerr takes a request for the whole series only (its partial-request setting is off). <c>SeerrUnlinked</c> (Seerr
    /// mode): Seerr answered and no Seerr account is linked to the person. <c>Size</c>: the typical sizes on the instance a
    /// request like this goes to (its GB estimate), when its library is in memory. <c>Rules</c> (phase 4b, Jellyfin Enhanced
    /// handling with household rules on): what the household's fixed conditions say about this request for this person
    /// (null: they don't apply). <c>Pool</c> (group quotas on): the shared pool the person's requests draw on now.
    /// <c>VisibilityUnknown</c> (4f round 7): <c>Visible</c> is false only because a title nobody has yet hasn't had its rating
    /// verified for the person's parental limits (not read yet, or the lookup failed lately), while its libraries are open to
    /// them: evidence still to prepare, not a refusal.
    /// </summary>
    public sealed record RequestPolicyFacts(Guid UserId, string Role, bool CanCreate, bool CanApprove, bool Can4k,
        bool Visible, string Revision, string Backend, string InstanceId, string ConnectionGeneration,
        int? Limit, int WindowDays, double GbLimit, string ParentalSignature,
        string? Refusal = null, string? SeerrSource = null, int? SeerrUser = null, long SeerrPermissions = 0, QuotaProjection? BackendQuota = null,
        RequestDiskFacts? Disk = null, bool SeerrWholeSeries = false, bool SeerrUnlinked = false, RequestSizeHint? Size = null,
        HouseholdRuleVerdict? Rules = null, GroupPoolBinding? Pool = null, bool VisibilityUnknown = false);
    /// <summary>
    /// The drive a request would land on is below the low-disk threshold (refusal <c>low_disk</c>): which instance,
    /// the folder measured (the folder named, the title's own folder, or the default root folder), and the drive's
    /// free and total bytes. Paths and names are for administrators only.
    /// </summary>
    /// <param name="InstanceId">Instance id.</param>
    /// <param name="Instance">Instance name.</param>
    /// <param name="Folder">The folder measured, as the arr names it.</param>
    /// <param name="Free">Free bytes of the drive holding it.</param>
    /// <param name="Total">Total bytes of that drive.</param>
    /// <param name="LimitPercent">The low-disk threshold (percent free) it is below.</param>
    public sealed record RequestDiskFacts(string InstanceId, string Instance, string Folder, long Free, long Total, int LimitPercent)
    {
        /// <summary>Whole percent of the drive that is free (rounded down).</summary>
        public int FreePercent => Total > 0 ? (int)Math.Floor(Math.Clamp(Free * 100.0 / Total, 0, 100)) : 0;
    }
    /// <summary>Policy seam with async preparation and a synchronous final-send check.</summary>
    public interface IRequestPolicy
    {
        /// <summary>Current household configuration.</summary>
        PluginConfiguration Configuration { get; }
        /// <summary>The evidence revision used by visibility decisions; evidence-free implementations use a constant.</summary>
        string EvidenceRevision => "-";
        /// <summary>Loads required rating and backend identity facts, bounded by cancellation.</summary>
        Task PrepareAsync(Guid userId, MutationInput input, CancellationToken ct);
        /// <summary>Refreshes backend identity and quota without looking up title ratings.</summary>
        Task PrepareIdentityAsync(Guid userId, bool movie, CancellationToken ct);
        /// <summary>Loads only the rating facts <see cref="Evaluate"/> reads for whether the person may see the title.</summary>
        Task PrepareVisibilityAsync(Guid userId, MutationInput input, CancellationToken ct) => Task.CompletedTask;
        /// <summary>Whether the human has Jellyfin administrator authority, independent of routing input.</summary>
        bool IsAdmin(Guid userId);
        /// <summary>Current identity, policy and configuration stamp without routing prerequisite reads.</summary>
        string AuthorizationStamp(Guid userId, MutationInput input);
        /// <summary>Reads current facts without network I/O.</summary>
        RequestPolicyFacts Evaluate(Guid userId, MutationInput input);
        /// <summary>Evaluates visibility at a stored request's persisted target, retaining current capability checks.</summary>
        RequestPolicyFacts Evaluate(Guid userId, MutationInput input, string targetKey) => Evaluate(userId, RequestDestination.Of(input, targetKey));
        /// <summary>
        /// The Sonarr/Radarr instance and connection a Jellyfin Enhanced-mode request like <paramref name="input"/>
        /// goes to, whatever handles requests right now (a move from Seerr records its links on that target before
        /// it switches; Seerr-mode facts carry no instance).
        /// </summary>
        (string InstanceId, string ConnectionGeneration) JeTarget(Guid userId, MutationInput input)
        {
            var facts = Evaluate(userId, input);
            return (facts.InstanceId, facts.ConnectionGeneration);
        }
        /// <summary>
        /// Whether adding a new title of this kind is paused for storage: the drive of the default standard
        /// instance's add root folder is below the low-disk threshold (no person, no title; null when it isn't, or
        /// nothing is known). The household-wide answer for surfaces that list titles nobody has yet.
        /// </summary>
        RequestDiskFacts? AddPause(bool movie) => null;
        /// <summary>
        /// The low-disk guard alone for a request like <paramref name="input"/> (no person): the facts it would refuse
        /// with, measured on the folder the download would land on for that very title, or null. Reads memory only. A
        /// cheap screen for lists of titles: null here means <see cref="Evaluate"/> gives no <c>low_disk</c> either.
        /// </summary>
        RequestDiskFacts? TitlePause(MutationInput input) => null;
        /// <summary>
        /// Makes sure the facts the low-disk guard reads for a request like <paramref name="input"/> are in memory
        /// (after a restart they may not be yet): starts a read of the target instance's system facts (disk space) and
        /// library index (whether it holds the title, so which folder counts) when none is held and waits for them
        /// briefly. JE mode only; never fails; the guard answers from what is known.
        /// </summary>
        Task PrepareDiskAsync(MutationInput input, CancellationToken ct) => Task.CompletedTask;
        /// <summary>
        /// <see cref="PrepareDiskAsync"/> for <see cref="AddPause"/>: the default standard instance's system facts only
        /// (a new add needs no library index).
        /// </summary>
        Task PrepareAddPauseAsync(bool movie, CancellationToken ct) => Task.CompletedTask;
        /// <summary>
        /// Whether anything can take the 4K copy of a movie (true) or series (false) now: a usable 4K Radarr/Sonarr in
        /// Jellyfin Enhanced mode, a 4K server in Seerr (as last read) in Seerr mode. Null when it isn't known (nothing
        /// is concluded then). Reads memory only.
        /// </summary>
        bool? Has4kTarget(bool movie) => null;
        /// <summary>
        /// Whether the low-disk guard can reach a verdict for a request like <paramref name="input"/> now (Sonarr/Radarr
        /// handling with the guard on): the target instance's disk facts, and whether it holds the title, are in memory and
        /// the drive of the folder it would land on is listed. False starts the missing reads. True when nothing needs
        /// knowing (guard off, Seerr handling, no usable instance: the send refuses then). Automatic sends wait while false.
        /// </summary>
        bool DiskKnown(MutationInput input) => true;
        /// <summary>
        /// The low-disk guard's two answers for a request like <paramref name="input"/> on <paramref name="config"/>: the
        /// facts it would refuse with (<see cref="TitlePause"/>) and whether a verdict can be reached (<see cref="DiskKnown"/>),
        /// both from ONE read of each published snapshot they use. Memory only: no lock, no I/O, starts nothing; the
        /// automatic-write check reads it in its final decision (<see cref="WarmDisk"/> starts the missing reads before).
        /// </summary>
        (RequestDiskFacts? Pause, bool Known) Disk(MutationInput input, PluginConfiguration config);
        /// <summary>Starts the reads <see cref="Disk"/> needs that aren't in memory yet (never waits).</summary>
        void WarmDisk(MutationInput input)
        {
        }
        /// <summary>
        /// The person's household role on <paramref name="config"/> given whether they are a Jellyfin administrator
        /// (<paramref name="admin"/>, read by <see cref="IsAdmin"/>): memory only, read in the automatic-write check's decision.
        /// </summary>
        string RoleOf(Guid userId, bool admin, PluginConfiguration config);
        /// <summary>
        /// The version of the person's Jellyfin permissions (a FactVersion sample): odd while a change to them may be
        /// landing, moved by each change. <see cref="IsAdmin"/> reads Jellyfin's database, so the automatic-write check
        /// gathers it before its decision and compares this. Memory only.
        /// </summary>
        long PermissionVersion(Guid userId);
    }
    /// <summary>Central role, parental, destination, edition and disk policy.</summary>
    public sealed class RequestPolicy : IRequestPolicy
    {
        private readonly IArrJellyfinView _view;
        private readonly ArrStateStore _store;
        private readonly ArrInstanceLibraries _libraries;
        private readonly TitleAliases _aliases;
        private readonly SeerrParentalFilter _parental;
        private readonly ArrClientFactory _clients;
        private readonly IRequestBackend _backend;
        private readonly Func<PluginConfiguration> _config;
        private readonly IHouseholdRuleFacts? _ruleFacts;
        /// <summary>Creates policy over Jellyfin and the memory read models; <paramref name="ruleFacts"/> reads the title facts household rules need.</summary>
        public RequestPolicy(IArrJellyfinView view, ArrStateStore store, ArrInstanceLibraries libraries, TitleAliases aliases,
            SeerrParentalFilter parental, ArrClientFactory clients, IRequestBackend backend, IHouseholdRuleFacts? ruleFacts = null)
        {
            _view = view; _store = store; _libraries = libraries; _aliases = aliases; _parental = parental; _clients = clients; _backend = backend; _ruleFacts = ruleFacts;
            _config = () => JellyfinEnhanced.Instance?.Configuration ?? new PluginConfiguration();
        }
        /// <inheritdoc />
        public PluginConfiguration Configuration => _config();
        /// <inheritdoc />
        public bool IsAdmin(Guid userId) => _view.Viewer(userId)?.IsAdmin == true;
        /// <inheritdoc />
        public async Task PrepareAsync(Guid userId, MutationInput input, CancellationToken ct)
        {
            await PrepareVisibilityAsync(userId, input, ct).ConfigureAwait(false);
            await PrepareDiskAsync(input, ct).ConfigureAwait(false);
            await _backend.PrepareAsync(userId, input, ct).ConfigureAwait(false);
            await PrepareRulesAsync(userId, input, ct).ConfigureAwait(false);
        }
        /// <summary>
        /// Reads the title facts the person's household-rule conditions need (rating, genres, language, streaming), when
        /// the rules apply to them and any condition needs facts. Bounded; a failure leaves them unknown (a look).
        /// </summary>
        private Task PrepareRulesAsync(Guid userId, MutationInput input, CancellationToken ct)
        {
            var config = Configuration;
            if (_ruleFacts == null || !HouseholdFlags.RulesApply(config) || TitleKey.Parse(input.Key) is not { } key) return Task.CompletedTask;
            var viewer = _view.Viewer(userId);
            if (viewer == null || viewer.IsAdmin) return Task.CompletedTask;
            var role = NormalizeRole(Settings(config, userId).Role ?? config.ArrRequestDefaultRole, true);
            return HouseholdRules.Parse(config.ArrHouseholdRules).For(role) is { NeedsFacts: true } ? _ruleFacts.PrepareAsync(key, ct) : Task.CompletedTask;
        }
        /// <inheritdoc />
        public async Task PrepareVisibilityAsync(Guid userId, MutationInput input, CancellationToken ct)
        {
            var viewer = _view.Viewer(userId);
            if (TitleKey.Parse(input.Key) is not { } key) return;
            if (viewer is { HasParentalLimit: true } && _view.Copies(key, viewer, _aliases.Of(key)).IsProvenAbsent)
            {
                var tmdb = _aliases.Of(key).Append(key).FirstOrDefault(k => k.Provider == "tmdb")?.NumericId ?? 0;
                await _parental.MaySeeAbsentAsync(key.IsMovie ? "movie" : "tv", tmdb, userId.ToString("N"), ct).ConfigureAwait(false);
            }
        }
        /// <inheritdoc />
        public Task PrepareDiskAsync(MutationInput input, CancellationToken ct) => PrepareDiskAsync(input, true, ct);
        /// <inheritdoc />
        public Task PrepareAddPauseAsync(bool movie, CancellationToken ct) => PrepareDiskAsync(AddProbe(movie), false, ct);
        private async Task PrepareDiskAsync(MutationInput input, bool library, CancellationToken ct)
        {
            var config = Configuration;
            // Seerr mode: the guard reads only what is in memory, as it always has (Seerr picks its own server and folder).
            if (config.ArrLowDiskPercent <= 0 || config.ArrRequestBackend != "je" || TitleKey.Parse(input.Key) is not { } key) return;
            var (instance, _, _) = Target(input, key);
            if (instance is not { Usable: true }) return;
            var reads = new List<Task>(2);
            if (_store.PeekSystem(instance.Id) == null && _store.WarmSystem(instance) is { } system) reads.Add(Quietly(system));
            // Whether the instance holds the title decides the folder measured (its own, or the default root).
            if (library && _store.PeekLibrary(instance.Id) == null) reads.Add(Quietly(_store.GetLibraryAsync(instance, ct)));
            if (reads.Count == 0) return;
            // Bounded: a slow or failing instance doesn't hold the caller (the guard then answers from what is known).
            await Task.WhenAny(Task.WhenAll(reads), Task.Delay(DiskWait, ct)).ConfigureAwait(false);
        }
        /// <summary>Waits for a read, ignoring how it ended (the guard reads what it left in memory).</summary>
        private static async Task Quietly(Task read)
        {
            try
            {
                await read.ConfigureAwait(false);
            }
            catch (Exception)
            {
                // A failed or cancelled read leaves nothing new in memory; the guard answers from what is known.
            }
        }
        /// <summary>The request a new add of a movie or a series stands for (no title the instance holds).</summary>
        private static MutationInput AddProbe(bool movie)
            => movie ? new MutationInput { Key = "movie:tmdb:1" } : new MutationInput { Key = "tv:tvdb:1", Scope = "seasons", Seasons = new[] { 1 } };
        /// <summary>Longest wait for an instance's disk facts that aren't in memory yet.</summary>
        internal TimeSpan DiskWait { get; set; } = TimeSpan.FromSeconds(5);
        /// <inheritdoc />
        public Task PrepareIdentityAsync(Guid userId, bool movie, CancellationToken ct)
            => _backend.PrepareAsync(userId, movie ? new MutationInput { Key = "movie:tmdb:1" } : new MutationInput { Key = "tv:tvdb:1", Scope = "seasons", Seasons = new[] { 1 } }, ct);
        /// <inheritdoc />
        public RequestPolicyFacts Evaluate(Guid userId, MutationInput input) => EvaluateCore(userId, input, null);
        /// <inheritdoc />
        public RequestPolicyFacts Evaluate(Guid userId, MutationInput input, string targetKey)
            => EvaluateCore(userId, RequestDestination.Of(input, targetKey), targetKey);
        private RequestPolicyFacts EvaluateCore(Guid userId, MutationInput input, string? targetKey)
        {
            RequestPolicyFacts? facts = null;
            for (var attempt = 0; attempt < 3; attempt++)
            {
                var before = AuthorizationStamp(userId, input);
                facts = EvaluateOnce(userId, input, targetKey);
                if (before == AuthorizationStamp(userId, input)) return facts;
            }
            return facts! with { Refusal = "authorization_changed", CanCreate = false, CanApprove = false, Can4k = false, Visible = false };
        }
        /// <summary>Current parental evidence source, configuration and region revision.</summary>
        public string EvidenceRevision => _parental?.EvidenceRevision ?? "-";

        /// <inheritdoc />
        public string AuthorizationStamp(Guid user, MutationInput input)
        {
            var viewer = _view.Viewer(user);
            var native = viewer?.Handle is User account ? JsonSerializer.Serialize(SeerrParentalFilter.PolicyFor(account)) : string.Empty;
            var generations = string.Join("|", _store.Registry.All().Select(i => _clients.ConnectionGeneration(i.Id)));
            return MutationInput.Hash(JsonSerializer.Serialize(Configuration) + "|" + viewer?.PolicyRevision + "|" + native + "|" + _view.Revision + "|" + _libraries.Revision + "|" + generations + "|" + _backend.Binding(user, input) + "|" + EvidenceRevision);
        }
        private bool NativeScopeAllowed(MutationInput input, JfCopy copy, StatusViewer viewer)
        {
            if (TitleKey.Parse(input.Key)!.IsMovie || !viewer.HasParentalLimit) return true;
            var seasons = input.SeasonNumbers.ToHashSet();
            if (_view.Seasons(copy.ItemId, viewer).Any(s => s.Hidden && seasons.Contains(s.Season))) return false;
            var episodes = _view.Episodes(copy.ItemId, null, viewer, true).Where(e => e.Hidden);
            return input.Scope == "episodes"
                ? !episodes.Any(e => input.Episodes.Any(ask => ask.Season == e.Season && ask.Episode >= e.Episode && ask.Episode <= Math.Max(e.Episode, e.EpisodeEnd ?? e.Episode)))
                : !episodes.Any(e => seasons.Contains(e.Season));
        }
        private RequestPolicyFacts EvaluateOnce(Guid userId, MutationInput input, string? targetKey)
        {
            var config = Configuration;
            var viewer = _view.Viewer(userId);
            var settings = Settings(config, userId);
            var role = viewer?.IsAdmin == true ? "Admin" : NormalizeRole(settings.Role ?? config.ArrRequestDefaultRole, HouseholdFlags.Rules(config));
            var defaults = RoleSettings(config, role);
            var key = TitleKey.Parse(input.Key)!;
            // The default instance of the edition's role: 4K only ever goes to a 4K instance, standard to a
            // standard one (never an anime or "other" instance picked by accident).
            var (instance, instanceId, generation) = Target(input, key);
            var binding = _backend.Binding(userId, input);
            var visible = false;
            var unknown = false;
            SeerrParentalFilter.AbsentSignature? signature = null;
            if (viewer != null)
            {
                // The copies the lookup saw decide (finished or not); the absent-title rule needs a proven absence, so a
                // lookup that couldn't finish and saw nothing fails closed.
                var lookup = _view.Copies(key, viewer, _aliases.Of(key));
                var copies = lookup.Seen;
                var source = targetKey == null ? binding.Source : RequestDestination.SeerrSource(targetKey);
                var target = Landing(input, key, instance, source);
                // Administrators may handle an unknown destination. Resolved libraries and parental visibility
                // remain mandatory, including for an administrator with restricted access.
                var destinationVisible = !target.Resolved && viewer.IsAdmin
                    || viewer.Handle is User account && ArrInstanceLibraries.CanOpen(account, target, _libraries.Libraries());
                if (copies.Count > 0)
                {
                    visible = copies.Any(c => c.Visible && NativeScopeAllowed(input, c, viewer)) && destinationVisible;
                }
                else if (lookup.IsProvenAbsent)
                {
                    visible = destinationVisible;
                    if (viewer.HasParentalLimit)
                    {
                        var tmdb = _aliases.Of(key).Append(key).FirstOrDefault(k => k.Provider == "tmdb")?.NumericId ?? 0;
                        var open = visible;
                        visible &= _parental.MaySeeAbsent(key.IsMovie ? "movie" : "tv", tmdb, userId.ToString("N"), out signature);
                        unknown = open && !visible && _parental.AbsentVerdict(key.IsMovie ? "movie" : "tv", tmdb, userId.ToString("N")) == null;
                    }
                }
            }
            var enabled = config.ArrIntegrationEnabled && config.ArrPhase1Enabled && config.ArrPhase3Enabled && config.ArrRequestBackend is "je" or "seerr";
            var can4k = Can4k(config, key.IsMovie, config.ArrRequestBackend, role == "Admin" || (settings.FourKInstances ?? defaults.FourKInstances)?.Contains(instanceId, StringComparer.OrdinalIgnoreCase) == true,
                instance?.Role == ArrInstanceRole.FourK, binding.FourKEnabled, binding.Can4k);
            var canApprove = role is "Manager" or "Admin" && (config.ArrRequestBackend != "seerr" || role == "Admin" || binding.CanManage);
            var refusal = viewer == null ? "user_required" : !enabled ? "feature_disabled" : !visible ? "not_visible_to_user" :
                input.InstanceId != null && instance == null ? "invalid_instance" :
                instance != null && (!instance.Usable || instance.Kind != (key.IsMovie ? ArrKind.Radarr : ArrKind.Sonarr) || (instance.Role == ArrInstanceRole.FourK) != (input.Variant == "4k")) ? "instance_changed" : null;
            if (refusal == null && (input.ProfileId.HasValue || input.RootFolder != null))
            {
                var system = instance == null ? null : _store.PeekSystem(instance.Id);
                if (system == null || (input.ProfileId.HasValue && !system.QualityProfiles.Any(p => p.Id == input.ProfileId)) ||
                    (input.RootFolder != null && (!BridgePaths.Safe(input.RootFolder) || !system.RootFolders.Any(r => r.Path != null && BridgePaths.SamePath(r.Path, input.RootFolder))))) refusal = "invalid_choice";
            }
            // Seerr options (administrators, Seerr mode): checked against Seerr's servers as last read, never guessed.
            if (refusal == null && input.HasSeerrOptions) refusal = SeerrOptionsRefusal(config, binding);
            var disk = refusal == null && instance != null ? LowDisk(config, instance, input, key) : null;
            if (disk != null) refusal = "low_disk";
            var revision = MutationInput.Hash(JsonSerializer.Serialize(config) + "|" + viewer?.PolicyRevision + "|" + _view.Revision + "|" + _libraries.Revision + "|" + role + "|" + binding);
            // Seerr picks its own server: a Seerr-mode request is bound to the Seerr identity, never to an arr connection,
            // so an arr's address or key changing doesn't hold it (the instance above still decides where it lands for visibility).
            var seerrMode = config.ArrRequestBackend == "seerr";
            var configuredLimit = settings.QuotaLimit ?? defaults.QuotaLimit ?? config.ArrRequestQuotaLimit;
            // A Manager's or Admin's asks go ahead whatever they have used (only a Member's count can hold one for an OK),
            // so their allowance has no limit: no cost line ever shows them the household's limit as theirs.
            int? limit = configuredLimit < 0 || config.ArrRequestPreset == "approve_everything" || role is "Manager" or "Admin" or "Trusted" ? null : configuredLimit == 0 ? (config.ArrRequestPreset == "open_house" ? 15 : 7) : Math.Clamp(configuredLimit, 1, 10000);
            if (config.ArrRequestBackend == "seerr") limit = binding.Quota?.Limit;
            var size = instance is { Usable: true } ? SizeHint(_store.PeekLibrary(instance.Id), _aliases.Of(key).Prepend(key)) : null;
            var windowDays = config.ArrRequestBackend == "seerr" ? Math.Clamp(binding.QuotaWindowDays, 1, 365) : Math.Clamp(config.ArrRequestQuotaWindowDays, 1, 365);
            return new(userId, role, role != "Watcher" && (config.ArrRequestBackend != "seerr" || binding.UserId == null || binding.CanRequest), canApprove, can4k, visible, revision, config.ArrRequestBackend,
                seerrMode ? string.Empty : instanceId, seerrMode ? string.Empty : generation,
                limit, windowDays,
                Math.Max(0, settings.QuotaGb ?? defaults.QuotaGb ?? config.ArrRequestQuotaGb), JsonSerializer.Serialize(signature),
                refusal, binding.Source, binding.UserId, binding.Permissions, binding.Quota, disk, seerrMode && binding.SeerrWholeSeries, seerrMode && binding.SeerrUnlinked,
                size, Rules(config, role, key, input, size),
                HouseholdFlags.Pools(config) ? GroupQuotaPolicy.For(GroupQuotaPolicy.Parse(config.ArrGroupQuotaPools), userId, role, windowDays) : null,
                unknown);
        }
        /// <summary>
        /// The Jellyfin libraries a request like <paramref name="input"/> lands in, which decide who may see it (review
        /// round 5, security-r5-1): where it ACTUALLY goes, never only where the title usually is.
        /// <list type="bullet">
        /// <item>An administrator's Seerr choice: the root folder chosen on the Seerr server chosen, resolved through the
        /// unique usable instance linked to that Seerr server (imported from Seerr; same kind). Unknown or ambiguous
        /// links need access to every library (administrators always qualify). Seerr adds a title it doesn't have yet there, so the title's own folder doesn't count.</item>
        /// <item>An arr folder named (administrators): that folder on the instance.</item>
        /// <item>Otherwise the title's own folder on the instance (the default root for a title it doesn't have).</item>
        /// </list>
        /// A folder that resolves to no library needs every library (see <see cref="ArrInstanceLibraries.CanOpen(User, ArrLibraryTarget, IReadOnlyList{JfLibraryRoot})"/>).
        /// </summary>
        /// <param name="input">The request.</param>
        /// <param name="key">Its title key.</param>
        /// <param name="instance">The instance its kind and edition go to.</param>
        /// <param name="source">The persisted Seerr source for stored requests; current source for a new ask.</param>
        private ArrLibraryTarget Landing(MutationInput input, TitleKey key, ArrConnection? instance, string? source)
        {
            if (input.HasSeerrOptions && input.SeerrRootFolder is { } seerrFolder)
            {
                var kind = key.IsMovie ? ArrKind.Radarr : ArrKind.Sonarr;
                var linked = _store.Registry.All().Where(i => i.Kind == kind && input.SeerrServerId is int server && i.SeerrServerId == server).ToList();
                // A root path is local to its server. Neither the default instance nor an arbitrary matching link proves
                // where this server's folder lands; an unresolved target makes CanOpen require every library.
                return linked.Count != 1 || !linked[0].Usable || !_backend.RepresentsSeerrServer(source, input, linked[0].Url, _store.Registry.ResolveApiKey(linked[0]))
                    ? new ArrLibraryTarget(null, null, ArrLibraryProblem.NoInstance)
                    : _libraries.Resolve(linked[0], seerrFolder);
            }
            if (instance == null) return new ArrLibraryTarget(null, null, ArrLibraryProblem.NoInstance);
            return input.RootFolder == null ? _libraries.ResolveTitle(instance, key) : _libraries.Resolve(instance, input.RootFolder);
        }
        /// <summary>
        /// What the household's fixed conditions say about this request for a person of <paramref name="role"/> (memory
        /// only), or null when they don't apply (rules off, Seerr handling, an unruled role, no condition set).
        /// </summary>
        private HouseholdRuleVerdict? Rules(PluginConfiguration config, string role, TitleKey key, MutationInput input, RequestSizeHint? size)
        {
            if (!HouseholdFlags.RulesApply(config) || HouseholdRules.Parse(config.ArrHouseholdRules).For(role) is not { } rules) return null;
            var facts = rules.NeedsFacts ? _ruleFacts?.Peek(key) : null;
            return HouseholdRules.Evaluate(rules, HouseholdRules.Version(config.ArrHouseholdRules, config.ArrHouseholdStreamingCountry, config.ArrHouseholdStreamingServices),
                facts, RequestSizeHint.Estimate(input, size), config.ArrHouseholdStreamingCountry, HouseholdRules.Services(config.ArrHouseholdStreamingServices),
                (cert, country) => _ruleFacts?.Score(cert, country));
        }
        /// <summary>
        /// The administrator's "Only allow requesting one season at a time" applies to an ask: in Jellyfin Enhanced mode
        /// always, in Seerr mode only while Seerr takes partial requests (with whole series only it has no effect, as
        /// with Seerr's own season picker).
        /// </summary>
        /// <param name="config">Configuration.</param>
        /// <param name="facts">The asker's policy facts.</param>
        internal static bool SingleSeasonOnly(PluginConfiguration config, RequestPolicyFacts facts)
            => config.JellyseerrSingleSeasonRequestOnly && (facts.Backend == "je" || (facts.Backend == "seerr" && !facts.SeerrWholeSeries));
        /// <summary>
        /// The low-disk pause of a request like <paramref name="input"/> on <paramref name="instance"/>, or null. JE mode
        /// measures the drive holding the folder the download would be imported into: the title's own folder when the
        /// instance already holds it (a search or a merge lands there, whatever folder is named), else the folder named
        /// (administrators), else the instance's default root folder (a new add); with the library index not read yet
        /// (after a restart) whether it holds the title is unknown, so there's no verdict. Seerr mode (Seerr picks the
        /// server and folder) measures only the folder named or the default root, as it always has, and starts no reads.
        /// Nothing is paused while the threshold is 0, no folder is known (an add with no defaults is held for them
        /// anyway) or the instance's disk facts aren't read yet.
        /// </summary>
        /// <param name="config">Configuration.</param>
        /// <param name="instance">Target instance.</param>
        /// <param name="input">Request.</param>
        /// <param name="key">Its title key.</param>
        /// <param name="newAdd">A new add by definition (<see cref="AddPause"/>): the default root, no library lookup.</param>
        internal RequestDiskFacts? LowDisk(PluginConfiguration config, ArrConnection instance, MutationInput input, TitleKey key, bool newAdd = false)
        {
            if (config.ArrLowDiskPercent <= 0) return null;
            var direct = config.ArrRequestBackend == "je";
            var system = _store.PeekSystem(instance.Id);
            if (system == null)
            {
                // Not read since a restart: start the read (the next answer has it); nothing is known to be full yet.
                if (direct) _ = _store.WarmSystem(instance);
                return null;
            }
            return LowDisk(config, instance, input, key, system, !direct || newAdd ? null : _store.PeekLibrary(instance.Id), newAdd);
        }
        // The verdict on snapshots already read: memory only, starts nothing.
        private RequestDiskFacts? LowDisk(PluginConfiguration config, ArrConnection instance, MutationInput input, TitleKey key, ArrSystemSnapshot? system, ArrLibrarySnapshot? library, bool newAdd)
        {
            if (config.ArrLowDiskPercent <= 0 || system == null) return null;
            string? folder;
            if (config.ArrRequestBackend != "je" || newAdd) folder = input.RootFolder ?? instance.Defaults?.RootFolderPath;
            else if (library == null) return null;
            else folder = HeldFolder(library, key.Title) ?? input.RootFolder ?? instance.Defaults?.RootFolderPath;
            return LowDiskAt(config, instance, system, folder);
        }
        private static RequestDiskFacts? LowDiskAt(PluginConfiguration config, ArrConnection instance, ArrSystemSnapshot? system, string? folder)
        {
            if (config.ArrLowDiskPercent <= 0 || system == null || string.IsNullOrWhiteSpace(folder)) return null;
            var disk = system.DiskSpace.Where(d => d.Path != null && BridgePaths.IsUnder(folder, d.Path)).OrderByDescending(d => d.Path!.Length).FirstOrDefault();
            if (disk?.TotalSpace is not long total || total <= 0 || disk.FreeSpace is not long free) return null;
            return 100.0 * free / total < config.ArrLowDiskPercent
                ? new RequestDiskFacts(instance.Id, instance.Name, folder, Math.Max(0, free), total, config.ArrLowDiskPercent)
                : null;
        }
        /// <summary>Fewest files a median size is taken from (fewer: the fixed estimate).</summary>
        internal const int SizeSamples = 3;
        /// <summary>Smallest median taken as a real size (GB); below it the files are samples or placeholders.</summary>
        internal const double SizeFloorGb = 0.1;
        private static readonly ConditionalWeakTable<ArrLibrarySnapshot, Tuple<double?, double?>> Typical = new();
        /// <summary>
        /// The typical sizes on an instance (from its library index in memory; null when not read yet): the median movie
        /// file and the median episode file (a series' size over its episode files), each from at least
        /// <see cref="SizeSamples"/> files, and the episodes per season of the series <paramref name="keys"/> names when the
        /// instance holds it. Worked out once per library read.
        /// </summary>
        /// <param name="library">The instance's library index.</param>
        /// <param name="keys">The title asked for, under every id it is known by.</param>
        internal static RequestSizeHint? SizeHint(ArrLibrarySnapshot? library, IEnumerable<TitleKey> keys)
        {
            if (library == null) return null;
            var typical = Typical.GetValue(library, l => Tuple.Create(
                MedianGb(l.Movies.Where(m => m.HasFile && m.SizeOnDisk > 0).Select(m => (double)m.SizeOnDisk)),
                MedianGb(l.Series.Where(x => x.EpisodeFileCount > 0 && x.SizeOnDisk > 0).Select(x => (double)x.SizeOnDisk / x.EpisodeFileCount))));
            IReadOnlyDictionary<int, int>? seasons = null;
            foreach (var key in keys.Where(k => !k.IsMovie).Select(k => k.Title))
            {
                var series = key.Provider switch
                {
                    "tvdb" when key.NumericId is int tvdb => library.SeriesByTvdb(tvdb),
                    "tmdb" when key.NumericId is int tmdb => library.SeriesByTmdb(tmdb),
                    "imdb" => library.SeriesByImdb(key.Id),
                    _ => null,
                };
                if (series == null) continue;
                seasons = series.Seasons.Where(x => x.TotalEpisodeCount > 0).GroupBy(x => x.SeasonNumber).ToDictionary(g => g.Key, g => g.First().TotalEpisodeCount);
                break;
            }
            return typical.Item1 == null && typical.Item2 == null && seasons is not { Count: > 0 } ? null : new RequestSizeHint(typical.Item1, typical.Item2, seasons is { Count: > 0 } ? seasons : null);
        }
        private static double? MedianGb(IEnumerable<double> bytes)
        {
            var sorted = bytes.OrderBy(b => b).ToList();
            if (sorted.Count < SizeSamples) return null;
            var mid = sorted.Count / 2;
            var gb = (sorted.Count % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) / 1_000_000_000d;
            return gb < SizeFloorGb ? null : Math.Round(gb, 1);
        }
        /// <summary>The folder of a title an instance's library index holds (under any of its known ids), or null.</summary>
        private string? HeldFolder(ArrLibrarySnapshot library, TitleKey title)
        {
            foreach (var key in _aliases.Of(title).Prepend(title))
            {
                if (key.IsMovie == title.IsMovie && RequestPlaces.HeldIn(library, key) is { Path: { Length: > 0 } path }) return path;
            }
            return null;
        }
        // The final transport decision may use published arr identities only. Ordinary policy preparation keeps
        // its full alias composition above, preserving legacy reads before entering the memory-only final check.
        private string? HeldArrFolder(ArrLibrarySnapshot library, TitleKey title)
        {
            foreach (var key in _aliases.ArrOnly(title).Prepend(title))
                if (key.IsMovie == title.IsMovie && RequestPlaces.HeldIn(library, key) is { Path: { Length: > 0 } path }) return path;
            return null;
        }
        /// <inheritdoc />
        public RequestDiskFacts? TitlePause(MutationInput input)
        {
            if (TitleKey.Parse(input.Key) is not { } key) return null;
            var (instance, _, _) = Target(input, key);
            return instance is { Usable: true } ? LowDisk(Configuration, instance, input, key) : null;
        }
        /// <inheritdoc />
        public bool DiskKnown(MutationInput input)
        {
            WarmDisk(input);
            return Disk(input, Configuration).Known;
        }
        /// <inheritdoc />
        public void WarmDisk(MutationInput input)
        {
            var config = Configuration;
            if (config.ArrLowDiskPercent <= 0 || config.ArrRequestBackend != "je" || TitleKey.Parse(input.Key) is not { } key || Instance(input, key) is not { Usable: true } instance) return;
            if (_store.PeekSystem(instance.Id) == null) _ = Quietly(_store.WarmSystem(instance) ?? Task.CompletedTask);
            if (_store.PeekLibrary(instance.Id) == null) _ = Quietly(_store.GetLibraryAsync(instance, CancellationToken.None));
        }
        /// <inheritdoc />
        public (RequestDiskFacts? Pause, bool Known) Disk(MutationInput input, PluginConfiguration config)
        {
            if (TitleKey.Parse(input.Key) is not { } key || Instance(input, key) is not { Usable: true } instance) return (null, true);
            // One read of each published snapshot (a refresh replaces it whole): both answers come from the same ones.
            var system = _store.PeekSystem(instance.Id);
            var library = _store.PeekLibrary(instance.Id);
            var direct = config.ArrRequestBackend == "je";
            var folder = (direct && library != null ? HeldArrFolder(library, key.Title) : null) ?? input.RootFolder ?? instance.Defaults?.RootFolderPath;
            var pause = direct && library == null ? null : LowDiskAt(config, instance, system, folder);
            if (config.ArrLowDiskPercent <= 0 || !direct) return (pause, true);
            if (system == null || library == null) return (pause, false);
            return (pause, string.IsNullOrWhiteSpace(folder) || system.DiskSpace.Any(d => d.Path != null && BridgePaths.IsUnder(folder, d.Path) && d.TotalSpace is > 0 && d.FreeSpace != null));
        }
        /// <inheritdoc />
        public string RoleOf(Guid userId, bool admin, PluginConfiguration config)
            => admin ? "Admin" : NormalizeRole(Settings(config, userId).Role ?? config.ArrRequestDefaultRole);
        /// <inheritdoc />
        public long PermissionVersion(Guid userId) => Automation.JellyfinUserVersions.Sample(userId);
        /// <inheritdoc />
        public RequestDiskFacts? AddPause(bool movie)
        {
            var input = AddProbe(movie);
            var key = TitleKey.Parse(input.Key)!;
            var (instance, _, _) = Target(input, key);
            return instance is { Usable: true } ? LowDisk(Configuration, instance, input, key, newAdd: true) : null;
        }
        /// <inheritdoc />
        public (string InstanceId, string ConnectionGeneration) JeTarget(Guid userId, MutationInput input)
        {
            var (_, id, generation) = Target(input, TitleKey.Parse(input.Key)!);
            return (id, generation);
        }
        /// <summary>
        /// The instance a request goes to: the one named (administrators), else the default instance of the
        /// edition's role (4K only ever to a 4K instance, standard to a standard one; never an anime or "other"
        /// instance picked by accident), with its connection generation.
        /// </summary>
        private (ArrConnection? Instance, string Id, string Generation) Target(MutationInput input, TitleKey key)
        {
            var instance = Instance(input, key);
            return (instance, instance?.Id ?? string.Empty, instance == null ? string.Empty : _clients.ConnectionGeneration(instance.Id) ?? string.Empty);
        }
        // The instance a request like this goes to (the configuration's registry: memory only).
        private ArrConnection? Instance(MutationInput input, TitleKey key)
            => input.InstanceId != null ? _store.Registry.Get(input.InstanceId) :
                _store.Registry.DefaultFor(key.IsMovie ? ArrKind.Radarr : ArrKind.Sonarr, input.Variant == "4k" ? ArrInstanceRole.FourK : ArrInstanceRole.Standard);
        /// <inheritdoc />
        public bool? Has4kTarget(bool movie)
        {
            var config = Configuration;
            if (!(config.ArrIntegrationEnabled && config.ArrPhase1Enabled && config.ArrPhase3Enabled)) return null;
            return config.ArrRequestBackend switch
            {
                "je" => _store.Registry.DefaultFor(movie ? ArrKind.Radarr : ArrKind.Sonarr, ArrInstanceRole.FourK) != null,
                "seerr" => _backend.FourKServer(movie),
                _ => null,
            };
        }
        /// <summary>The one edition-capability calculation used by every submit path.</summary>
        public static bool Can4k(PluginConfiguration config, bool movie, string backend, bool capability, bool fourKInstance, bool seerrEnabled, bool seerrPermission)
            => EditionEnabled(config, movie) &&
               (backend == "seerr" ? seerrEnabled && seerrPermission : backend == "je" && capability && fourKInstance);
        /// <summary>The JE edition switch; legacy Seerr controls apply until phase 3 is enabled.</summary>
        public static bool EditionEnabled(PluginConfiguration config, bool movie)
            => config.ArrIntegrationEnabled && config.ArrPhase1Enabled && config.ArrPhase3Enabled
                ? movie ? config.ArrRequest4kMoviesEnabled : config.ArrRequest4kSeriesEnabled
                : movie ? config.JellyseerrEnable4KRequests : config.JellyseerrEnable4KTvRequests;
        /// <summary>
        /// Validated server-owned role. Trusted counts only while household rules are on (<paramref name="trusted"/>);
        /// otherwise a stored Trusted is a Member, as before the role existed.
        /// </summary>
        public static string NormalizeRole(string? role, bool trusted = false) => role is "Kid" or "Member" or "Manager" ? role : role == "Trusted" ? trusted ? "Trusted" : "Member" : "Watcher";
        internal static RequestUserSettings Settings(PluginConfiguration config, Guid user)
        {
            try
            {
                var map = JsonSerializer.Deserialize<Dictionary<string, RequestUserSettings>>(config.ArrRequestUsers, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                return map?.FirstOrDefault(p => Guid.TryParse(p.Key, out var id) && id == user).Value ?? new();
            }
            catch (JsonException) { return new(); }
        }
        private static RequestUserSettings RoleSettings(PluginConfiguration config, string role)
        {
            try
            {
                return JsonSerializer.Deserialize<Dictionary<string, RequestUserSettings>>(config.ArrRequestRoles, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })?.GetValueOrDefault(role) ?? new();
            }
            catch (JsonException) { return new(); }
        }
        internal static int RefusalStatus(string reason) => reason switch
        {
            "invalid_defaults" or "invalid_choice" or "invalid_instance" or "seerr_options_invalid" => 400,
            "instance_changed" or "seerr_options_changed" => 409,
            "backend_unavailable" => 503,
            _ => 403,
        };
        /// <summary>Seerr permissions that allow choosing a server, quality profile and root folder (ADMIN implies all).</summary>
        internal const long SeerrAdvancedPermissions = (long)(JellyseerrPermission.ADMIN | JellyseerrPermission.REQUEST_ADVANCED | JellyseerrPermission.MANAGE_REQUESTS);
        /// <summary>True when Seerr permission bits allow advanced request options.</summary>
        /// <param name="permissions">Seerr permission bits.</param>
        internal static bool SeerrAdvanced(long permissions) => (permissions & SeerrAdvancedPermissions) != 0;
        /// <summary>
        /// Why an input carrying Seerr options can't be asked for by this person now (null: it can): Jellyfin Enhanced
        /// handles requests (<c>invalid_defaults</c>), the switch is off (<c>seerr_options_disabled</c>), the person's Seerr
        /// account isn't known (<c>backend_unavailable</c>) or lacks Seerr's advanced-request permission
        /// (<c>seerr_advanced_required</c>), or the options don't fit Seerr's current servers (<c>seerr_options_invalid</c>,
        /// <c>seerr_options_changed</c>, or <c>backend_unavailable</c> while they aren't known). Being a Jellyfin
        /// administrator is checked by the callers (routing is administrators' only).
        /// </summary>
        internal static string? SeerrOptionsRefusal(PluginConfiguration config, RequestBackendBinding binding)
        {
            if (config.ArrRequestBackend != "seerr") return "invalid_defaults";
            if (!HouseholdFlags.SeerrOptions(config)) return "seerr_options_disabled";
            if (binding.UserId == null) return binding.SeerrUnlinked ? "seerr_advanced_required" : "backend_unavailable";
            if (!SeerrAdvanced(binding.Permissions)) return "seerr_advanced_required";
            return binding.SeerrOptions switch
            {
                SeerrBackend.OptionsValid => null,
                "seerr_options_invalid" or "seerr_options_changed" => binding.SeerrOptions,
                _ => "backend_unavailable",
            };
        }
        internal static string? Check(RequestPolicyFacts requester, RequestPolicyFacts? approver, MutationInput input, bool approval)
        {
            if (requester.Refusal != null) return requester.Refusal;
            if (!requester.CanCreate) return "requests_create_required";
            // An approver may grant an edition the requester does not hold, but must hold it themselves.
            if (input.Variant == "4k" && !(approval ? approver?.Can4k == true : requester.Can4k)) return "requests_4k_required";
            if (approval && (approver?.Refusal != null || approver?.CanApprove != true)) return approver?.Refusal ?? "requests_approve_required";
            return null;
        }
    }
}
