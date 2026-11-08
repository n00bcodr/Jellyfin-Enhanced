// Global aliases
global using JUser = Jellyfin.Database.Implementations.Entities.User;
global using JSortOrder = Jellyfin.Database.Implementations.Enums.SortOrder;

using System.Globalization;
using Jellyfin.Plugin.SpoilerGuard.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using System.IO;
using System.Collections.Generic;
using System.Linq;
using System;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using MediaBrowser.Controller.Configuration;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json;
using MediaBrowser.Common.Net;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.SpoilerGuard
{
    public class SpoilerGuard : BasePlugin<PluginConfiguration>, IHasWebPages
    {
        private readonly IApplicationPaths _applicationPaths;
        private readonly IServerConfigurationManager _serverConfigurationManager;
        private readonly Logger _logger;
        private const string PluginName = "Spoiler Guard Lite";

        public SpoilerGuard(
            IApplicationPaths applicationPaths,
            IServerConfigurationManager serverConfigurationManager,
            IXmlSerializer xmlSerializer,
            Logger logger) : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
            _applicationPaths = applicationPaths;
            _serverConfigurationManager = serverConfigurationManager;
            _logger = logger;
            _logger.Info($"{PluginName} v{Version} initialized. Plugin logs will be written to: {_logger.CurrentLogFilePath}");

            // Set the User-Agent used by every Seerr/TMDB outbound HTTP call.
            // Cloudflare's Browser Integrity Check / Bot Fight Mode flags
            // empty UA as bot �            Helpers.Jellyseerr.SeerrHttpHelper.UserAgent = $"SpoilerGuard/{Version}";
            CleanupOldScript();
            CheckPluginPages(applicationPaths, serverConfigurationManager, 1);
            BackfillMissingDefaultShortcuts();
            BackfillCustomTagRuleKey();
        }

        /// <summary>
        /// The Custom tag rule id key to store: the current one, else a posted one, else a new
        /// one once there are rules (see <see cref="PluginConfiguration.CustomTagRuleKey"/>).
        /// </summary>
        private static string EnsureCustomTagRuleKey(PluginConfiguration incoming, PluginConfiguration? current)
        {
            if (!string.IsNullOrEmpty(current?.CustomTagRuleKey)) return current.CustomTagRuleKey;
            if (!string.IsNullOrEmpty(incoming.CustomTagRuleKey)) return incoming.CustomTagRuleKey;
            return incoming.CustomTagRules.Count > 0 ? CustomTagRuleSet.NewKey() : string.Empty;
        }

        // Rules saved before the key existed get one, so their ids stop naming the source.
        private void BackfillCustomTagRuleKey()
        {
            try
            {
                var config = Configuration;
                if (config == null || config.CustomTagRules.Count == 0 || !string.IsNullOrEmpty(config.CustomTagRuleKey)) return;
                UpdateConfiguration(stored =>
                {
                    if (!string.IsNullOrWhiteSpace(stored.CustomTagRuleKey)) return null;
                    stored.CustomTagRuleKey = CustomTagRuleSet.NewKey();
                    return stored;
                }, fullSave: false);
            }
            catch (Exception ex)
            {
                _logger.Warning($"Jellyfin Enhanced: could not store the Custom tag rule key: {ex.Message}");
            }
        }

        // Dedupes Shortcuts (XmlSerializer appends to constructor-initialized lists, doubling on each restart)
        // and backfills missing defaults. Reverse iteration so persisted XML rows win over constructor defaults.
        private void BackfillMissingDefaultShortcuts()
        {
            List<Shortcut>? originalShortcuts = null;
            try
            {
                int duplicatesDropped = 0;
                List<string> malformed = new();
                List<Shortcut> missing = new();
                // Read, rewritten and saved inside the configuration write lock, like every configuration write.
                var saved = UpdateConfiguration(
                    config =>
                    {
                        config.Shortcuts ??= new List<Shortcut>();
                        originalShortcuts = config.Shortcuts;

                        var seen = new HashSet<string>(StringComparer.Ordinal);
                        var dedupedReversed = new List<Shortcut>(originalShortcuts.Count);
                        var emptyKeyNames = new HashSet<string>(StringComparer.Ordinal);
                        for (int i = originalShortcuts.Count - 1; i >= 0; i--)
                        {
                            var s = originalShortcuts[i];
                            var name = s?.Name ?? string.Empty;
                            if (string.IsNullOrEmpty(name)) continue;
                            if (string.IsNullOrEmpty(s?.Key))
                            {
                                emptyKeyNames.Add(name);
                                continue;
                            }
                            if (seen.Add(name)) dedupedReversed.Add(s!);
                        }
                        var deduped = new List<Shortcut>(dedupedReversed.Count);
                        for (int i = dedupedReversed.Count - 1; i >= 0; i--) deduped.Add(dedupedReversed[i]);
                        malformed = emptyKeyNames.Where(n => !seen.Contains(n)).ToList();
                        duplicatesDropped = originalShortcuts.Count - deduped.Count - malformed.Count;

                        var defaults = new PluginConfiguration().Shortcuts ?? new List<Shortcut>();
                        missing = defaults.Where(d => !seen.Contains(d.Name ?? string.Empty)).ToList();
                        deduped.AddRange(missing);

                        if (duplicatesDropped == 0 && missing.Count == 0 && malformed.Count == 0) return null;

                        config.Shortcuts = deduped;
                        return config;
                    },
                    fullSave: false);
                if (!saved) return;
                _logger.Info(
                    $"Normalized shortcut list: dropped {duplicatesDropped} duplicate(s), " +
                    $"{malformed.Count} malformed entry/entries" +
                    (malformed.Count > 0 ? $" [{string.Join(", ", malformed)}]" : "") +
                    $", added {missing.Count} missing default(s)" +
                    (missing.Count > 0 ? $" [{string.Join(", ", missing.Select(s => s.Name))}]" : ""));
            }
            catch (IOException ex)
            {
                RollbackShortcuts(originalShortcuts);
                _logger.Error($"Failed to save normalized shortcut list to disk (check permissions and free space): {ex}");
            }
            catch (UnauthorizedAccessException ex)
            {
                RollbackShortcuts(originalShortcuts);
                _logger.Error($"Permission denied saving normalized shortcut list: {ex}");
            }
            catch (Exception ex)
            {
                RollbackShortcuts(originalShortcuts);
                _logger.Error($"Unexpected error normalizing shortcut list: {ex}");
            }
        }

        private void RollbackShortcuts(List<Shortcut>? original)
        {
            if (original == null) return;
            try
            {
                lock (AnalyticsCredentialLock)
                {
                    var config = Configuration;
                    if (config != null) config.Shortcuts = original;
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to roll back shortcut list after save failure: {ex}");
            }
        }

        public override string Name => PluginName;
        public override string Description => "Lightweight Spoiler Guard plugin for Jellyfin with Moonfin Trickplay support.";
        public override Guid Id => Guid.Parse("57ebfd1e-faf4-471b-8873-ae1ab461787d");
        public static SpoilerGuard? Instance { get; private set; }

        private string IndexHtmlPath => Path.Combine(_applicationPaths.WebPath, "index.html");

        public static string BrandingDirectory
        {
            get
            {
                if (Instance == null)
                    return string.Empty;

                var configPath = Instance.ConfigurationFilePath;
                if (string.IsNullOrWhiteSpace(configPath))
                    return string.Empty;

                var configDir = Path.GetDirectoryName(configPath);
                if (string.IsNullOrWhiteSpace(configDir))
                    return string.Empty;

                var pluginFolderName = Path.GetFileNameWithoutExtension(configPath) ?? "Jellyfin.Plugin.SpoilerGuard";
                return Path.Combine(configDir, pluginFolderName, "custom_branding");
            }
        }

        // Cache-busting key: plugin version plus the DLL's last-write timestamp, so
        // every build yields a distinct value even when the version is unchanged
        // (local dev/testing). Falls back to the bare version if the assembly
        // location can't be read (e.g. single-file hosting).
        internal string ScriptCacheKey
        {
            get
            {
                var version = Version?.ToString() ?? "unknown";
                try
                {
                    var location = typeof(SpoilerGuard).Assembly.Location;
                    if (!string.IsNullOrEmpty(location) && File.Exists(location))
                    {
                        var ticks = new FileInfo(location).LastWriteTimeUtc.Ticks;
                        return $"{version}-{ticks}";
                    }
                }
                catch (Exception ex)
                {
                    // Fall through to the bare version below.
                    _logger.Debug($"ScriptCacheKey: couldn't read assembly file metadata, using bare version: {ex.Message}");
                }

                return version;
            }
        }

        // The single source of truth for the client-script tag. Consumed both by the
        // request-time injection middleware (ScriptInjectionStartupFilter) and by the
        // legacy on-disk index.html rewrite, so the two never drift. plugin.js reads
        // the plugin/version/dev attributes off this tag.
        internal string BuildScriptTag()
        {
            var cacheKey = ScriptCacheKey;
            var devMode = Configuration?.DevMode == true;
            return $"<script plugin=\"{Name}\" version=\"{cacheKey}\" dev=\"{(devMode ? "true" : "false")}\" src=\"../SpoilerGuard/script?v={cacheKey}\" defer></script>";
        }

        public void InjectScript()
        {
            UpdateIndexHtml(true);
        }

        public override void OnUninstalling()
        {
            UpdateIndexHtml(false);
            base.OnUninstalling();
        }

        // Config-save side effects: flush every Seerr-related cache (fixing a bad
        // URL/key/blocklist must not take 10-30 minutes of cache TTL to appear
        // fixed), and hand Server-Side Tag Cache OFF<->ON flips to the tag-cache
        // transition queue — turning it off must actually release the cache
        // memory, and turning it on must catch up on the off window right away
        // rather than serving a stale snapshot until the daily 3 AM refresh.
        public override void UpdateConfiguration(BasePluginConfiguration configuration)
        {
            ArgumentNullException.ThrowIfNull(configuration);
            UpdateConfiguration(_ => configuration);
        }

        /// <summary>
        /// Saves the configuration <paramref name="build"/> makes from the stored one. <paramref name="build"/> runs
        /// inside the configuration write lock, the critical section every configuration write in the plugin goes
        /// through (a full save from the configuration page, the Media Tags tab's field patch, and the server's own
        /// bookkeeping writes: the maintenance toggle clear, the translation refresh signal, analytics state, the
        /// shortcut backfill), so a writer that builds on the stored configuration can never put back fields another
        /// write changed while it was building.
        /// </summary>
        /// <param name="build">Makes the configuration to save from the stored one (a new object, or the stored one
        /// changed in place); null saves nothing.</param>
        /// <param name="saved">Reads the configuration as stored (normalised), still inside the critical section.</param>
        /// <param name="fullSave">False for a server bookkeeping write that changes a field of the stored configuration
        /// in place: it is saved in the same critical section, without a full save's normalisation of posted values
        /// and without its after-effects (page checks, cache flushes, transitions), as before it took the lock.</param>
        /// <returns>Whether a configuration was saved.</returns>
        internal bool UpdateConfiguration(Func<PluginConfiguration, BasePluginConfiguration?> build, Action<PluginConfiguration>? saved = null, bool fullSave = true)
        {
            var result = build(Configuration);
            if (result is PluginConfiguration pc)
            {
                Configuration = pc;
                if (fullSave) SaveConfiguration();
                saved?.Invoke(pc);
            }
            return true;
        }

        /// <summary>
        /// The configuration write lock. Every configuration write builds and
        /// saves under it through the UpdateConfiguration overload taking a
        /// builder: full saves and Media Tags field patches (which swap in a new
        /// object) and the in-place bookkeeping writes (maintenance toggle clear,
        /// translation refresh signal, AnalyticsReportingService's post-HTTP
        /// credential/report state, the startup shortcut backfill), so no write
        /// can land on an object another write is replacing. Named for its first
        /// job: guarding the Analytics install credentials across the swap.
        /// </summary>
        internal static readonly object AnalyticsCredentialLock = new object();

        private readonly object _analyticsTransitionLock = new object();
        private Task _analyticsTransitionChain = Task.CompletedTask;

        /// <summary>
        /// Chains analytics opt-in/opt-out side effects so they run strictly in
        /// the order the admin's saves produced them, off the request thread.
        /// The chain can never fault: each link swallows and logs its own
        /// errors, so one failed transition can't block every later one.
        /// </summary>
        private void QueueAnalyticsTransition(string description, Func<Task> action)
        {
            lock (_analyticsTransitionLock)
            {
                var previous = _analyticsTransitionChain;
                _analyticsTransitionChain = Task.Run(async () =>
                {
                    await previous.ConfigureAwait(false);
                    try
                    {
                        await action().ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                    {
                        // Shutdown path, silent.
                    }
                    catch (Exception ex)
                    {
                        _logger.Warning($"Jellyfin Enhanced: failed to {description}: {ex.Message}");
                    }
                });
            }
        }
        private void CleanupOldScript()
        {
            try
            {
                var indexPath = IndexHtmlPath;
                if (!File.Exists(indexPath))
                {
                    _logger.Error($"Could not find index.html at path: {indexPath}");
                    return;
                }

                var content = File.ReadAllText(indexPath);
                var regex = new Regex($"<script[^>]*plugin=[\"']{Name}[\"'][^>]*>\\s*</script>\\n?");

                if (regex.IsMatch(content))
                {
                    _logger.Info("Found old Jellyfin Enhanced script tag in index.html. Removing it now.");
                    content = regex.Replace(content, string.Empty);
                    File.WriteAllText(indexPath, content);
                    _logger.Info("Successfully removed old script tag.");
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"Error during cleanup of old script from index.html: {ex.Message}");
            }
        }
        private void CheckPluginPages(IApplicationPaths applicationPaths, IServerConfigurationManager serverConfigurationManager, int pluginPageConfigVersion)
        {
            try
            {
            string pluginPagesConfig = Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellyfin.Plugin.PluginPages", "config.json");

            JObject config = new JObject();
            if (!File.Exists(pluginPagesConfig))
            {
                FileInfo info = new FileInfo(pluginPagesConfig);
                info.Directory?.Create();
            }
            else
            {
                config = JObject.Parse(File.ReadAllText(pluginPagesConfig));
            }

            if (!config.ContainsKey("pages"))
            {
                config.Add("pages", new JArray());
            }

            var namespaceName = typeof(SpoilerGuard).Namespace;

            JObject? hssPageConfig = config.Value<JArray>("pages")!.FirstOrDefault(x =>
                x.Value<string>("Id") == namespaceName) as JObject;

            if (hssPageConfig != null)
            {
                if ((hssPageConfig.Value<int?>("Version") ?? 0) < pluginPageConfigVersion)
                {
                    config.Value<JArray>("pages")!.Remove(hssPageConfig);
                }
            }

            Assembly? pluginPagesAssembly = AssemblyLoadContext.All.SelectMany(x => x.Assemblies).FirstOrDefault(x => x.FullName?.Contains("Jellyfin.Plugin.PluginPages") ?? false);

            Version earliestVersionWithSubUrls = new Version("2.4.1.0");
            bool supportsSubUrls = pluginPagesAssembly != null && pluginPagesAssembly.GetName().Version >= earliestVersionWithSubUrls;

            string rootUrl = serverConfigurationManager.GetNetworkConfiguration().BaseUrl.TrimStart('/').Trim();
            if (!string.IsNullOrEmpty(rootUrl))
            {
                rootUrl = $"/{rootUrl}";
            }

            var pluginConfig = Configuration;

            bool calendarExists = config.Value<JArray>("pages")!
                .Any(x => x.Value<string>("Id") == $"{namespaceName}.CalendarPage");

            bool downloadsExists = config.Value<JArray>("pages")!
                .Any(x => x.Value<string>("Id") == $"{namespaceName}.DownloadsPage");

            bool bookmarksExists = config.Value<JArray>("pages")!
                .Any(x => x.Value<string>("Id") == $"{namespaceName}.BookmarksPage");

            bool hiddenContentExists = config.Value<JArray>("pages")!
                .Any(x => x.Value<string>("Id") == $"{namespaceName}.HiddenContentPage");

            bool activityFeedExists = config.Value<JArray>("pages")!
                .Any(x => x.Value<string>("Id") == $"{namespaceName}.ActivityPage");

            bool catchUpExists = config.Value<JArray>("pages")!
                .Any(x => x.Value<string>("Id") == $"{namespaceName}.CatchUpPage");

            bool recommendationsExists = config.Value<JArray>("pages")!
                .Any(x => x.Value<string>("Id") == $"{namespaceName}.RecommendationsPage");

            // Only add calendar page if it's enabled and using plugin pages
            if (!calendarExists && pluginConfig.CalendarPageEnabled && pluginConfig.CalendarUsePluginPages)
            {
                config.Value<JArray>("pages")!.Add(new JObject
                {
                    { "Id", $"{namespaceName}.CalendarPage" },
                    { "Url", $"{(supportsSubUrls ? "" : rootUrl)}/SpoilerGuard/calendarPage" },
                    { "DisplayText", "Calendar" },
                    { "Icon", "calendar_today" },
                    { "Version", pluginPageConfigVersion }
                });
            }
            // Remove calendar page if it exists but is now disabled or not using plugin pages
            else if (calendarExists && (!pluginConfig.CalendarPageEnabled || !pluginConfig.CalendarUsePluginPages))
            {
                var calendarPage = config.Value<JArray>("pages")!
                    .FirstOrDefault(x => x.Value<string>("Id") == $"{namespaceName}.CalendarPage");
                if (calendarPage != null)
                {
                    config.Value<JArray>("pages")!.Remove(calendarPage);
                }
            }

            // Only add downloads page if it's enabled and using plugin pages
            if (!downloadsExists && pluginConfig.DownloadsPageEnabled && pluginConfig.DownloadsUsePluginPages)
            {
                config.Value<JArray>("pages")!.Add(new JObject
                {
                    { "Id", $"{namespaceName}.DownloadsPage" },
                    { "Url", $"{(supportsSubUrls ? "" : rootUrl)}/SpoilerGuard/downloadsPage" },
                    { "DisplayText", "Requests" },
                    { "Icon", "download" },
                    { "Version", pluginPageConfigVersion }
                });
            }
            // Remove downloads page if it exists but is now disabled or not using plugin pages
            else if (downloadsExists && (!pluginConfig.DownloadsPageEnabled || !pluginConfig.DownloadsUsePluginPages))
            {
                var downloadsPage = config.Value<JArray>("pages")!
                    .FirstOrDefault(x => x.Value<string>("Id") == $"{namespaceName}.DownloadsPage");
                if (downloadsPage != null)
                {
                    config.Value<JArray>("pages")!.Remove(downloadsPage);
                }
            }

            // Only add bookmarks page if it's enabled and using plugin pages
            if (!bookmarksExists && pluginConfig.BookmarksEnabled && pluginConfig.BookmarksUsePluginPages)
            {
                config.Value<JArray>("pages")!.Add(new JObject
                {
                    { "Id", $"{namespaceName}.BookmarksPage" },
                    { "Url", $"{(supportsSubUrls ? "" : rootUrl)}/SpoilerGuard/bookmarksPage" },
                    { "DisplayText", "Bookmarks" },
                    { "Icon", "bookmark" },
                    { "Version", pluginPageConfigVersion }
                });
            }
            // Remove bookmarks page if it exists but is now disabled or not using plugin pages
            else if (bookmarksExists && (!pluginConfig.BookmarksEnabled || !pluginConfig.BookmarksUsePluginPages))
            {
                var bookmarksPage = config.Value<JArray>("pages")!
                    .FirstOrDefault(x => x.Value<string>("Id") == $"{namespaceName}.BookmarksPage");
                if (bookmarksPage != null)
                {
                    config.Value<JArray>("pages")!.Remove(bookmarksPage);
                }
            }

            // Only add hidden content page if it's enabled and using plugin pages
            if (!hiddenContentExists && pluginConfig.HiddenContentEnabled && pluginConfig.HiddenContentUsePluginPages)
            {
                config.Value<JArray>("pages")!.Add(new JObject
                {
                    { "Id", $"{namespaceName}.HiddenContentPage" },
                    { "Url", $"{(supportsSubUrls ? "" : rootUrl)}/SpoilerGuard/hiddenContentPage" },
                    { "DisplayText", "Hidden Content" },
                    { "Icon", "visibility_off" },
                    { "Version", pluginPageConfigVersion }
                });
            }
            // Remove hidden content page if it exists but is now disabled or not using plugin pages
            else if (hiddenContentExists && (!pluginConfig.HiddenContentEnabled || !pluginConfig.HiddenContentUsePluginPages))
            {
                var hiddenContentPage = config.Value<JArray>("pages")!
                    .FirstOrDefault(x => x.Value<string>("Id") == $"{namespaceName}.HiddenContentPage");
                if (hiddenContentPage != null)
                {
                    config.Value<JArray>("pages")!.Remove(hiddenContentPage);
                }
            }

            // Only add activity feed page if it's enabled and using plugin pages
            if (!activityFeedExists && pluginConfig.ActivityFeedEnabled && pluginConfig.ActivityFeedUsePluginPages)
            {
                config.Value<JArray>("pages")!.Add(new JObject
                {
                    { "Id", $"{namespaceName}.ActivityPage" },
                    { "Url", $"{(supportsSubUrls ? "" : rootUrl)}/SpoilerGuard/activityPage" },
                    { "DisplayText", "Activity" },
                    { "Icon", "history" },
                    { "Version", pluginPageConfigVersion }
                });
            }
            // Remove activity feed page if it exists but is now disabled or not using plugin pages
            else if (activityFeedExists && (!pluginConfig.ActivityFeedEnabled || !pluginConfig.ActivityFeedUsePluginPages))
            {
                var activityPage = config.Value<JArray>("pages")!
                    .FirstOrDefault(x => x.Value<string>("Id") == $"{namespaceName}.ActivityPage");
                if (activityPage != null)
                {
                    config.Value<JArray>("pages")!.Remove(activityPage);
                }
            }

            // Only add recommendations page if it's enabled and using plugin pages
            if (!recommendationsExists && pluginConfig.RecommendationsPageEnabled && pluginConfig.RecommendationsUsePluginPages)
            {
                config.Value<JArray>("pages")!.Add(new JObject
                {
                    { "Id", $"{namespaceName}.RecommendationsPage" },
                    { "Url", $"{(supportsSubUrls ? "" : rootUrl)}/SpoilerGuard/recommendationsPage" },
                    { "DisplayText", "Recommendations" },
                    { "Icon", "auto_awesome" },
                    { "Version", pluginPageConfigVersion }
                });
            }
            // Remove recommendations page if it exists but is now disabled or not using plugin pages
            else if (recommendationsExists && (!pluginConfig.RecommendationsPageEnabled || !pluginConfig.RecommendationsUsePluginPages))
            {
                var recommendationsPage = config.Value<JArray>("pages")!
                    .FirstOrDefault(x => x.Value<string>("Id") == $"{namespaceName}.RecommendationsPage");
                if (recommendationsPage != null)
                {
                    config.Value<JArray>("pages")!.Remove(recommendationsPage);
                }
            }

            // Only add the catch up page if it's enabled and using plugin pages
            if (!catchUpExists && pluginConfig.CatchUpEnabled && pluginConfig.CatchUpUsePluginPages)
            {
                config.Value<JArray>("pages")!.Add(new JObject
                {
                    { "Id", $"{namespaceName}.CatchUpPage" },
                    { "Url", $"{(supportsSubUrls ? "" : rootUrl)}/SpoilerGuard/catchUpPage" },
                    { "DisplayText", "Catch Up" },
                    { "Icon", "style" },
                    { "Version", pluginPageConfigVersion }
                });
            }
            // Remove the catch up page if it exists but is now disabled or not using plugin pages
            else if (catchUpExists && (!pluginConfig.CatchUpEnabled || !pluginConfig.CatchUpUsePluginPages))
            {
                var catchUpPage = config.Value<JArray>("pages")!
                    .FirstOrDefault(x => x.Value<string>("Id") == $"{namespaceName}.CatchUpPage");
                if (catchUpPage != null)
                {
                    config.Value<JArray>("pages")!.Remove(catchUpPage);
                }
            }

            File.WriteAllText(pluginPagesConfig, config.ToString(Formatting.Indented));

            // Plugin Pages 3.0+ can register pages live. Older versions read config.json on restart.
            var pluginInterface = pluginPagesAssembly?.GetType("Jellyfin.Plugin.PluginPages.PluginInterface");
            var registerPage = pluginInterface?.GetMethod("RegisterPage");
            var removePage = pluginInterface?.GetMethod("RemovePage");
            // On server start Jellyfin builds plugins in name order, so this can run before Plugin Pages is
            // constructed. Its static methods then hit a null Instance; config.json above is what it reads on start.
            var pluginPagesInstance = pluginPagesAssembly?.GetType("Jellyfin.Plugin.PluginPages.PluginPagesPlugin")
                ?.GetProperty("Instance", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
            var pluginPagesNotConstructed = pluginPagesInstance != null && pluginPagesInstance.GetValue(null) == null;
            if (registerPage != null && removePage != null && !pluginPagesNotConstructed)
            {
                try
                {
                    foreach (var suffix in new[] { "CalendarPage", "DownloadsPage", "BookmarksPage", "HiddenContentPage", "ActivityPage", "CatchUpPage", "RecommendationsPage" })
                    {
                        var id = $"{namespaceName}.{suffix}";
                        removePage.Invoke(null, new object[] { id });
                        var page = config.Value<JArray>("pages")!.FirstOrDefault(x => x.Value<string>("Id") == id);
                        if (page != null)
                        {
                            registerPage.Invoke(null, new object[] { page });
                        }
                    }
                }
                catch (Exception ex)
                {
                    _logger.Warning($"Could not update Plugin Pages live, a restart is needed: {ex.InnerException?.Message ?? ex.Message}");
                }
            }
            }
            catch (Exception ex)
            {
                _logger.Error($"Error while updating Plugin Pages configuration: {ex.Message}");
            }
        }
        private void UpdateIndexHtml(bool inject)
        {
            try
            {
                var indexPath = IndexHtmlPath;
                if (!File.Exists(indexPath))
                {
                    _logger.Error($"Could not find index.html at path: {indexPath}");
                    return;
                }

                var content = File.ReadAllText(indexPath);
                var scriptTag = BuildScriptTag();
                var regex = new Regex($"<script[^>]*plugin=[\"']{Name}[\"'][^>]*>\\s*</script>\\n?");

                // Remove any old versions of the script tag first
                content = regex.Replace(content, string.Empty);

                if (inject)
                {
                    var closingBodyTag = "</body>";
                    if (content.Contains(closingBodyTag))
                    {
                        content = content.Replace(closingBodyTag, $"{scriptTag}\n{closingBodyTag}");
                        _logger.Info($"Successfully injected/updated the {PluginName} script.");
                    }
                    else
                    {
                        _logger.Warning("Could not find </body> tag in index.html. Script not injected.");
                        return; // Return early if injection point not found
                    }
                }
                else
                {
                    _logger.Info($"Successfully removed the {PluginName} script from index.html during uninstall.");
                }

                File.WriteAllText(indexPath, content);
            }
            catch (Exception ex)
            {
                _logger.Error($"Error while trying to update index.html: {ex.Message}");
            }
        }

        public IEnumerable<PluginPageInfo> GetPages()
        {
            return new[]
            {
                new PluginPageInfo
                {
                    Name = this.Name,
                    DisplayName = "Spoiler Guard Lite",
                    EnableInMainMenu = true,
                    EmbeddedResourcePath = "Jellyfin.Plugin.SpoilerGuard.Configuration.configPage.html",
                    // MenuIcon was previously ignored - jellyfin-web hardcoded <Folder /> regardless of
                    // this value. Jellyfin 12 reads it https://github.com/jellyfin/jellyfin-web/commit/ca55f7998bb774b3c05af3ae410b1b24f72805a5
                    MenuIcon = "tune"
                },
                // The old address of the Media Tags settings, now the Media Tags tab of the page above:
                // a redirect only (bookmarks, older links), not in the dashboard menu.
                new PluginPageInfo
                {
                    Name = "SpoilerGuardMediaTags",
                    DisplayName = "Jellyfin Enhanced: Media Tags",
                    EnableInMainMenu = false,
                    EmbeddedResourcePath = "Jellyfin.Plugin.SpoilerGuard.Configuration.mediaTagsPage.html",
                }
            };
        }

        public IEnumerable<PluginPageInfo> GetViews()
        {
            return new[]
            {
                new PluginPageInfo {
                    Name = "calendarPage",
                    EmbeddedResourcePath = $"{GetType().Namespace}.PluginPages.CalendarPage.html"
                },
                new PluginPageInfo {
                    Name = "downloadsPage",
                    EmbeddedResourcePath = $"{GetType().Namespace}.PluginPages.DownloadsPage.html"
                },
                new PluginPageInfo {
                    Name = "bookmarksPage",
                    EmbeddedResourcePath = $"{GetType().Namespace}.PluginPages.BookmarksPage.html"
                },
                new PluginPageInfo {
                    Name = "hiddenContentPage",
                    EmbeddedResourcePath = $"{GetType().Namespace}.PluginPages.HiddenContentPage.html"
                },
                new PluginPageInfo {
                    Name = "recommendationsPage",
                    EmbeddedResourcePath = $"{GetType().Namespace}.PluginPages.RecommendationsPage.html"
                },
                new PluginPageInfo {
                    Name = "activityPage",
                    EmbeddedResourcePath = $"{GetType().Namespace}.PluginPages.ActivityPage.html"
                },
                new PluginPageInfo {
                    Name = "catchUpPage",
                    EmbeddedResourcePath = $"{GetType().Namespace}.PluginPages.CatchUpPage.html"
                }
            };
        }
    }
}