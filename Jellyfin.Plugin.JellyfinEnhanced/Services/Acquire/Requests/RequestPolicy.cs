using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>Per-user server-owned overrides. Missing fields retain preset behavior.</summary>
    public sealed record RequestUserSettings
    {
        /// <summary>Watcher, Kid, Member, or Manager. Administrator comes from Jellyfin.</summary>
        public string? Role { get; init; }
        /// <summary>Grant 4K on the listed instance ids only.</summary>
        public string[]? FourKInstances { get; init; }
        /// <summary>Optional rolling limit override, negative for unlimited.</summary>
        public int? QuotaLimit { get; init; }
        /// <summary>Optional estimated GB cap override.</summary>
        public double? QuotaGb { get; init; }
    }
    /// <summary>Current policy facts, evaluated again after every asynchronous prerequisite.</summary>
    public sealed record RequestPolicyFacts(Guid UserId, string Role, bool CanCreate, bool CanApprove, bool Can4k,
        bool Visible, string Revision, string Backend, string InstanceId, string ConnectionGeneration,
        int? Limit, int WindowDays, double GbLimit, string ParentalSignature,
        string? Refusal = null, string? SeerrSource = null, int? SeerrUser = null, long SeerrPermissions = 0, QuotaProjection? BackendQuota = null);
    /// <summary>Policy seam with async preparation and a synchronous final-send check.</summary>
    public interface IRequestPolicy
    {
        /// <summary>Current household configuration.</summary>
        PluginConfiguration Configuration { get; }
        /// <summary>Loads required rating and backend identity facts, bounded by cancellation.</summary>
        Task PrepareAsync(Guid userId, MutationInput input, CancellationToken ct);
        /// <summary>Refreshes backend identity and quota without looking up title ratings.</summary>
        Task PrepareIdentityAsync(Guid userId, bool movie, CancellationToken ct);
        /// <summary>Whether the human has Jellyfin administrator authority, independent of routing input.</summary>
        bool IsAdmin(Guid userId);
        /// <summary>Current identity, policy and configuration stamp without routing prerequisite reads.</summary>
        string AuthorizationStamp(Guid userId, MutationInput input);
        /// <summary>Reads current facts without network I/O.</summary>
        RequestPolicyFacts Evaluate(Guid userId, MutationInput input);
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
        /// <summary>Creates policy over Jellyfin and the memory read models.</summary>
        public RequestPolicy(IArrJellyfinView view, ArrStateStore store, ArrInstanceLibraries libraries, TitleAliases aliases,
            SeerrParentalFilter parental, ArrClientFactory clients, IRequestBackend backend)
        {
            _view = view; _store = store; _libraries = libraries; _aliases = aliases; _parental = parental; _clients = clients; _backend = backend;
            _config = () => JellyfinEnhanced.Instance?.Configuration ?? new PluginConfiguration();
        }
        /// <inheritdoc />
        public PluginConfiguration Configuration => _config();
        /// <inheritdoc />
        public bool IsAdmin(Guid userId) => _view.Viewer(userId)?.IsAdmin == true;
        /// <inheritdoc />
        public async Task PrepareAsync(Guid userId, MutationInput input, CancellationToken ct)
        {
            var viewer = _view.Viewer(userId);
            var key = TitleKey.Parse(input.Key)!;
            if (viewer is { HasParentalLimit: true } && _view.Copies(key, viewer, _aliases.Of(key)).Count == 0)
            {
                var tmdb = _aliases.Of(key).Append(key).FirstOrDefault(k => k.Provider == "tmdb")?.NumericId ?? 0;
                await _parental.MaySeeAbsentAsync(key.IsMovie ? "movie" : "tv", tmdb, userId.ToString("N"), ct).ConfigureAwait(false);
            }
            await _backend.PrepareAsync(userId, input, ct).ConfigureAwait(false);
        }
        /// <inheritdoc />
        public Task PrepareIdentityAsync(Guid userId, bool movie, CancellationToken ct)
            => _backend.PrepareAsync(userId, movie ? new MutationInput { Key = "movie:tmdb:1" } : new MutationInput { Key = "tv:tvdb:1", Scope = "seasons", Seasons = new[] { 1 } }, ct);
        /// <inheritdoc />
        public RequestPolicyFacts Evaluate(Guid userId, MutationInput input)
        {
            RequestPolicyFacts? facts = null;
            for (var attempt = 0; attempt < 3; attempt++)
            {
                var before = AuthorizationStamp(userId, input);
                facts = EvaluateOnce(userId, input);
                if (before == AuthorizationStamp(userId, input)) return facts;
            }
            return facts! with { Refusal = "authorization_changed", CanCreate = false, CanApprove = false, Can4k = false, Visible = false };
        }
        /// <inheritdoc />
        public string AuthorizationStamp(Guid user, MutationInput input)
        {
            var viewer = _view.Viewer(user);
            var native = viewer?.Handle is User account ? JsonSerializer.Serialize(SeerrParentalFilter.PolicyFor(account)) : string.Empty;
            var generations = string.Join("|", _store.Registry.All().Select(i => _clients.ConnectionGeneration(i.Id)));
            return MutationInput.Hash(JsonSerializer.Serialize(Configuration) + "|" + viewer?.PolicyRevision + "|" + native + "|" + _view.Revision + "|" + _libraries.Revision + "|" + generations + "|" + _backend.Binding(user, input));
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
        private RequestPolicyFacts EvaluateOnce(Guid userId, MutationInput input)
        {
            var config = Configuration;
            var viewer = _view.Viewer(userId);
            var settings = Settings(config, userId);
            var role = viewer?.IsAdmin == true ? "Admin" : NormalizeRole(settings.Role ?? config.ArrRequestDefaultRole);
            var defaults = RoleSettings(config, role);
            var key = TitleKey.Parse(input.Key)!;
            // The default instance of the edition's role: 4K only ever goes to a 4K instance, standard to a
            // standard one (never an anime or "other" instance picked by accident).
            var instance = input.InstanceId != null ? _store.Registry.Get(input.InstanceId) :
                _store.Registry.DefaultFor(key.IsMovie ? ArrKind.Radarr : ArrKind.Sonarr, input.Variant == "4k" ? ArrInstanceRole.FourK : ArrInstanceRole.Standard);
            var instanceId = instance?.Id ?? string.Empty;
            var generation = instance == null ? string.Empty : _clients.ConnectionGeneration(instance.Id) ?? string.Empty;
            var binding = _backend.Binding(userId, input);
            var visible = false;
            SeerrParentalFilter.AbsentSignature? signature = null;
            if (viewer != null)
            {
                var copies = _view.Copies(key, viewer, _aliases.Of(key));
                if (copies.Count > 0)
                {
                    var target = instance == null ? new ArrLibraryTarget(null, null, "no_instance") : input.RootFolder == null ? _libraries.ResolveTitle(instance, key) : _libraries.Resolve(instance, input.RootFolder);
                    visible = copies.Any(c => c.Visible && NativeScopeAllowed(input, c, viewer)) && viewer.Handle is User user && ArrInstanceLibraries.CanOpen(user, target, _libraries.Libraries());
                }
                else
                {
                    var libraries = instance == null ? new ArrLibraryTarget(null, null, "no_instance") : input.RootFolder == null ? _libraries.ResolveTitle(instance, key) : _libraries.Resolve(instance, input.RootFolder);
                    visible = viewer.Handle is User user && ArrInstanceLibraries.CanOpen(user, libraries, _libraries.Libraries());
                    if (viewer.HasParentalLimit)
                    {
                        var tmdb = _aliases.Of(key).Append(key).FirstOrDefault(k => k.Provider == "tmdb")?.NumericId ?? 0;
                        visible &= _parental.MaySeeAbsent(key.IsMovie ? "movie" : "tv", tmdb, userId.ToString("N"), out signature);
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
                    (input.RootFolder != null && (!BridgePaths.Safe(input.RootFolder) || !system.RootFolders.Any(r => r.Path != null && BridgePaths.SamePath(r.Path, input.RootFolder))))) refusal = "invalid_defaults";
            }
            if (refusal == null && instance != null && config.ArrLowDiskPercent > 0)
            {
                var root = input.RootFolder ?? instance.Defaults?.RootFolderPath;
                var disks = _store.PeekSystem(instance.Id)?.DiskSpace;
                var disk = disks?.Where(d => root != null && d.Path != null && BridgePaths.IsUnder(root, d.Path)).OrderByDescending(d => d.Path!.Length).FirstOrDefault();
                if (disk?.TotalSpace > 0 && disk.FreeSpace.HasValue && 100.0 * disk.FreeSpace.Value / disk.TotalSpace.Value < config.ArrLowDiskPercent) refusal = "low_disk";
            }
            var revision = MutationInput.Hash(JsonSerializer.Serialize(config) + "|" + viewer?.PolicyRevision + "|" + _view.Revision + "|" + _libraries.Revision + "|" + role + "|" + binding);
            // Seerr picks its own server: a Seerr-mode request is bound to the Seerr identity, never to an arr connection,
            // so an arr's address or key changing doesn't hold it (the instance above still decides where it lands for visibility).
            var seerrMode = config.ArrRequestBackend == "seerr";
            var configuredLimit = settings.QuotaLimit ?? defaults.QuotaLimit ?? config.ArrRequestQuotaLimit;
            int? limit = configuredLimit < 0 || config.ArrRequestPreset == "approve_everything" ? null : configuredLimit == 0 ? (config.ArrRequestPreset == "open_house" ? 15 : 7) : Math.Clamp(configuredLimit, 1, 10000);
            if (config.ArrRequestBackend == "seerr") limit = binding.Quota?.Limit;
            return new(userId, role, role != "Watcher" && (config.ArrRequestBackend != "seerr" || binding.UserId == null || binding.CanRequest), canApprove, can4k, visible, revision, config.ArrRequestBackend,
                seerrMode ? string.Empty : instanceId, seerrMode ? string.Empty : generation,
                limit, config.ArrRequestBackend == "seerr" ? Math.Clamp(binding.QuotaWindowDays, 1, 365) : Math.Clamp(config.ArrRequestQuotaWindowDays, 1, 365),
                Math.Max(0, settings.QuotaGb ?? defaults.QuotaGb ?? config.ArrRequestQuotaGb), JsonSerializer.Serialize(signature),
                refusal, binding.Source, binding.UserId, binding.Permissions, binding.Quota);
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
        /// <summary>Validated server-owned role.</summary>
        public static string NormalizeRole(string? role) => role is "Kid" or "Member" or "Manager" ? role : "Watcher";
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
        internal static int RefusalStatus(string reason) => reason is "invalid_defaults" or "invalid_instance" ? 400 : reason == "instance_changed" ? 409 : 403;
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
