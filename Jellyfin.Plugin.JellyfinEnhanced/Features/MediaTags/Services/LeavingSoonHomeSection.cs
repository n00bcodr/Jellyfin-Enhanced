using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using Microsoft.Extensions.Hosting;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services
{
    /// <summary>
    /// The "Leaving soon" row on a Home Screen Sections (HSS) home page. HSS keeps registered
    /// sections in memory only, through a static <c>PluginInterface.RegisterSection(JObject)</c>
    /// reached by reflection (no compile-time reference), so this service registers on every
    /// start, retrying until HSS has loaded, and again whenever the row is turned on later. A
    /// section is only listed once HSS's saved configuration has a <c>SectionSettings</c> entry
    /// with the same id, which registration does not create: this adds one (enabled, users may
    /// turn it off) only while it is missing and never touches other entries. The section id is a
    /// CSS-safe name (the client uses it as a class). Without HSS, or without File Transformation
    /// (which HSS needs to draw its rows), nothing is registered and the admin page says so. The
    /// state goes to <see cref="LeavingSoonService.HomeRowStatus"/>, which the admin status reads.
    /// </summary>
    public sealed class LeavingSoonHomeSection : BackgroundService
    {
        /// <summary>The section id: a CSS class name, so it starts with a letter and has no dashes or digits first.</summary>
        public const string SectionId = "JellyfinEnhancedLeavingSoon";
        /// <summary>Most items the row lists.</summary>
        public const int Limit = 20;
        private static readonly TimeSpan Poll = TimeSpan.FromSeconds(15);
        private static readonly TimeSpan SlowPoll = TimeSpan.FromMinutes(1);

        private readonly LeavingSoonService _leaving;
        private readonly Logger _logger;
        // HSS's RegisterSection has run (once per process: HSS keeps the section until it restarts).
        private bool _invoked;
        // What a finished registration found: registered, or ft-missing (HSS present without File Transformation).
        private string? _registered;

        public LeavingSoonHomeSection(LeavingSoonService leaving, Logger logger)
        {
            _leaving = leaving;
            _logger = logger;
        }

        /// <summary>Whether the row is wanted: its switch and a Maintainerr URL.</summary>
        public static bool Wanted(PluginConfiguration? config) => LeavingSoonSources.HomeRowWanted(config);

        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            // Plugins load before the host finishes starting; give HSS a moment before the first look.
            try { await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken).ConfigureAwait(false); } catch (OperationCanceledException) { return; }
            while (!stoppingToken.IsCancellationRequested)
            {
                var delay = SlowPoll;
                try
                {
                    var config = JellyfinEnhanced.Instance?.Configuration;
                    if (!Wanted(config))
                    {
                        // HSS keeps a registered section until restart; the results method answers empty meanwhile.
                        // The admin status says "off" while the row is not wanted, whatever this held.
                        _leaving.HomeRowStatus = null;
                    }
                    else if (_registered == null)
                    {
                        delay = TryRegister() ? SlowPoll : Poll;
                    }
                    else
                    {
                        _leaving.HomeRowStatus = _registered;
                    }
                }
                catch (Exception ex)
                {
                    _leaving.HomeRowStatus = "failed";
                    _logger.Warning($"[LeavingSoon] Home row registration failed: {ex.GetBaseException().Message}");
                }

                try { await Task.Delay(delay, stoppingToken).ConfigureAwait(false); } catch (OperationCanceledException) { return; }
            }
        }

        /// <summary>One registration attempt. True when done or when nothing more can be done for now (HSS absent).</summary>
        private bool TryRegister()
        {
            var assemblies = AssemblyLoadContext.All.SelectMany(x => x.Assemblies).ToList();
            var hss = assemblies.FirstOrDefault(a => a.GetName().Name == "Jellyfin.Plugin.HomeScreenSections");
            if (hss == null) { _leaving.HomeRowStatus = "hss-missing"; return false; }
            var ft = assemblies.Any(a => a.GetName().Name == "Jellyfin.Plugin.FileTransformation");
            var method = hss.GetType("Jellyfin.Plugin.HomeScreenSections.PluginInterface")?.GetMethod("RegisterSection", BindingFlags.Public | BindingFlags.Static);
            if (method == null || method.GetParameters().Length != 1)
            {
                _leaving.HomeRowStatus = "failed";
                _logger.Warning("[LeavingSoon] Home Screen Sections is installed but has no PluginInterface.RegisterSection(JObject); the Leaving soon row is not registered.");
                return true;
            }

            var payload = new JObject
            {
                ["id"] = SectionId,
                ["displayText"] = "Leaving soon",
                ["limit"] = 1,
                ["additionalData"] = "leaving-soon",
                ["resultsAssembly"] = typeof(LeavingSoonHomeSection).Assembly.FullName,
                ["resultsClass"] = typeof(LeavingSoonSectionResults).FullName,
                ["resultsMethod"] = nameof(LeavingSoonSectionResults.GetResults),
            };
            // HSS's parameter type is its own Newtonsoft JObject; a plugin's copy of the type is not the same type.
            var parameterType = method.GetParameters()[0].ParameterType;
            object argument = parameterType.IsInstanceOfType(payload) ? payload : parameterType.GetMethod("Parse", new[] { typeof(string) })?.Invoke(null, new object[] { payload.ToString() }) ?? throw new InvalidOperationException("Cannot build HSS's payload type " + parameterType.FullName);
            if (!_invoked)
            {
                method.Invoke(null, new[] { argument });
                _invoked = true;
            }

            // A failed settings entry (it throws) is tried again on the next look, without registering twice.
            var settings = EnsureSectionSettings(hss);
            _registered = ft ? "registered" : "ft-missing";
            _leaving.HomeRowStatus = _registered;
            _logger.Info($"[LeavingSoon] Registered the Leaving soon home row with Home Screen Sections{(settings ? " and added its section entry" : string.Empty)}{(ft ? string.Empty : "; File Transformation is not installed, so HSS cannot draw it")}.");
            return true;
        }

        /// <summary>
        /// Add a <c>SectionSettings</c> entry for the row to HSS's configuration when it has none (enabled,
        /// user override allowed, one instance, order after the built-ins, portrait cards), through HSS's own
        /// plugin instance and <c>SaveConfiguration</c>. Other entries are left as they are. True when one was added.
        /// </summary>
        internal static bool EnsureSectionSettings(Assembly hss)
        {
            var pluginType = hss.GetTypes().FirstOrDefault(t => t.Name == "HomeScreenSectionsPlugin") ?? throw new InvalidOperationException("HSS plugin type not found");
            var plugin = pluginType.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static)?.GetValue(null) ?? throw new InvalidOperationException("HSS plugin instance not found");
            var configuration = pluginType.GetProperty("Configuration")?.GetValue(plugin) ?? throw new InvalidOperationException("HSS configuration not found");
            var property = configuration.GetType().GetProperty("SectionSettings") ?? throw new InvalidOperationException("HSS SectionSettings not found");
            var current = property.GetValue(configuration) as Array ?? Array.CreateInstance(property.PropertyType.GetElementType()!, 0);
            var entryType = property.PropertyType.GetElementType() ?? throw new InvalidOperationException("HSS SectionSettings element type not found");
            foreach (var entry in current)
            {
                if (entry != null && string.Equals(entryType.GetProperty("SectionId")?.GetValue(entry) as string, SectionId, StringComparison.Ordinal)) return false;
            }

            var added = Activator.CreateInstance(entryType) ?? throw new InvalidOperationException("Cannot create an HSS SectionSettings entry");
            void Set(string name, object value)
            {
                var p = entryType.GetProperty(name);
                if (p == null || !p.CanWrite) return;
                if (p.PropertyType.IsEnum) { if (Enum.TryParse(p.PropertyType, value.ToString(), out var parsed)) p.SetValue(added, parsed); }
                else p.SetValue(added, Convert.ChangeType(value, p.PropertyType));
            }

            Set("SectionId", SectionId);
            Set("Enabled", true);
            Set("AllowUserOverride", true);
            Set("LowerLimit", 1);
            Set("UpperLimit", 1);
            Set("OrderIndex", 999);
            Set("ViewMode", "Portrait");
            Set("HideWatchedItems", false);
            var next = Array.CreateInstance(entryType, current.Length + 1);
            Array.Copy(current, next, current.Length);
            next.SetValue(added, current.Length);
            property.SetValue(configuration, next);
            pluginType.GetMethod("SaveConfiguration", Type.EmptyTypes)?.Invoke(plugin, null);
            return true;
        }
    }

    /// <summary>
    /// HSS's results handler for the row (a normal instance class: HSS creates it through dependency
    /// injection on every request). Maintainerr's members from the last read, soonest removal first,
    /// as the requesting user may see them (library access and parental rules through Jellyfin's own
    /// visibility check), movies and series only (a leaving season or episode shows as its series),
    /// at most <see cref="LeavingSoonHomeSection.Limit"/>. Empty while the row is off.
    /// </summary>
    public sealed class LeavingSoonSectionResults
    {
        private readonly ILibraryManager _library;
        private readonly IUserManager _users;
        private readonly IDtoService _dto;
        private readonly LeavingSoonService _leaving;

        public LeavingSoonSectionResults(ILibraryManager library, IUserManager users, IDtoService dto, LeavingSoonService leaving)
        {
            _library = library;
            _users = users;
            _dto = dto;
            _leaving = leaving;
        }

        /// <summary>What HSS sends: the user and the registration's additional data.</summary>
        public sealed class Request
        {
            public Guid UserId { get; set; }
            public string? AdditionalData { get; set; }
        }

        public QueryResult<BaseItemDto> GetResults(Request request)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!LeavingSoonHomeSection.Wanted(config)) return new QueryResult<BaseItemDto>(Array.Empty<BaseItemDto>());
            var user = request.UserId == Guid.Empty ? null : _users.GetUserById(request.UserId);
            if (user == null) return new QueryResult<BaseItemDto>(Array.Empty<BaseItemDto>());
            var items = Order(_leaving.MaintainerrItems(config), id => _library.GetItemById(id), item => item.IsVisibleStandalone(user));
            var dtos = _dto.GetBaseItemDtos(items, new DtoOptions(), user);
            return new QueryResult<BaseItemDto>(dtos);
        }

        /// <summary>
        /// The row's items: each member (or, for a season or episode, its series) the user can see
        /// (<paramref name="visible"/>; one that throws is left out), once, soonest first (undated last),
        /// up to the limit.
        /// </summary>
        internal static List<BaseItem> Order(IReadOnlyList<(Guid ItemId, long? DeleteAt)> members, Func<Guid, BaseItem?> resolve, Func<BaseItem, bool> visible)
        {
            var seen = new HashSet<Guid>();
            var picked = new List<(BaseItem Item, long? DeleteAt)>();
            foreach (var (id, at) in members.OrderBy(m => m.DeleteAt ?? long.MaxValue))
            {
                var item = resolve(id);
                item = item switch
                {
                    Episode e when e.SeriesId != Guid.Empty => resolve(e.SeriesId),
                    Season s when s.SeriesId != Guid.Empty => resolve(s.SeriesId),
                    _ => item,
                };
                if (item is not (Movie or Series) || !seen.Add(item.Id)) continue;
                try { if (!visible(item)) continue; } catch { continue; }
                picked.Add((item, at));
                if (picked.Count >= LeavingSoonHomeSection.Limit) break;
            }

            return picked.Select(p => p.Item).ToList();
        }
    }
}
