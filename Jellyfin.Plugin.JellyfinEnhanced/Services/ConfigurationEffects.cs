using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Common.Plugins;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>What a reconcile of the configuration's runtime effects did, for the generation a caller asked about.</summary>
    /// <param name="Generation">The configuration generation the effects now follow.</param>
    /// <param name="Maintenance">"applied", "superseded" (a newer configuration took over), "failed" or "pending" (not done within the wait).</param>
    /// <param name="CustomTabs">The Custom Tabs sync's outcome (null when it didn't run).</param>
    public sealed record ConfigurationEffectsOutcome(long Generation, string Maintenance, CustomTabsSyncOutcome? CustomTabs);

    /// <summary>The Custom Tabs sync's outcome: ok (clean, or nothing to do), its status (noop, ok, skipped, failed) and the words for an administrator.</summary>
    public sealed record CustomTabsSyncOutcome(bool Ok, string Status, string Detail);

    /// <summary>
    /// The one server owner of the configuration's runtime effects: maintenance mode (accounts disabled and restored, the
    /// window's popup) and the Custom Tabs entries Jellyfin Enhanced manages. Every write of the configuration advances its
    /// generation (JellyfinEnhanced.SaveConfiguration). A write that may change what these effects follow (a configuration
    /// page save, Jellyfin's configuration route, a restore, a server field writer changing them) asks for a reconcile
    /// (<see cref="Request"/>); this owner runs ONE reconcile at a time, each from the configuration held when it runs, never
    /// from a snapshot a client or an earlier write carried, and checks the generation again at each effect: an older Enable
    /// can never land after a newer Disable completed, and two administrators' saves take effect in the server's order.
    /// A caller may wait, bounded, for the reconcile covering its generation (<see cref="ReconcileAsync"/>) and learn whether
    /// it was applied, superseded by a newer configuration, or failed.
    /// Lock order: the maintenance gate, then <see cref="JellyfinEnhanced.ConfigurationLock"/> (taken briefly, never across an
    /// await). Writers holding the configuration lock only signal (Request); they never wait for the gate.
    /// </summary>
    public sealed class ConfigurationEffects : IHostedService
    {
        /// <summary>The running owner (null before the host started it, and in tests that don't).</summary>
        public static ConfigurationEffects? Instance { get; private set; }

        /// <summary>Custom Tabs' plugin id.</summary>
        public static readonly Guid CustomTabsPluginId = Guid.Parse("fbacd0b6-fd46-4a05-b0a4-2045d6a135b0");

        // Per managed Custom Tabs entry: the flags that ask for it (all three on), the flag recording that Jellyfin Enhanced
        // created it, its title, and the exact HTML that identifies it as Jellyfin Enhanced's (the configuration page's list).
        internal static readonly (string Master, string Parent, string Auto, string Owned, string Title, string Html)[] ManagedTabs =
        {
            ("BookmarksEnabled", "BookmarksUseCustomTabs", "BookmarksAutoCreateCustomTab", "BookmarksCustomTabJeOwned", "Bookmarks", "<div class=\"sections bookmarks\"></div>"),
            ("HiddenContentEnabled", "HiddenContentUseCustomTabs", "HiddenContentAutoCreateCustomTab", "HiddenContentCustomTabJeOwned", "Hidden Content", "<div class=\"jellyfinenhanced hidden-content\"></div>"),
            ("DownloadsPageEnabled", "DownloadsUseCustomTabs", "DownloadsAutoCreateCustomTab", "DownloadsCustomTabJeOwned", "Requests", "<div class=\"jellyfinenhanced requests\"></div>"),
            ("CalendarPageEnabled", "CalendarUseCustomTabs", "CalendarAutoCreateCustomTab", "CalendarCustomTabJeOwned", "Calendar", "<div class=\"jellyfinenhanced calendar\"></div>"),
            ("RecommendationsPageEnabled", "RecommendationsUseCustomTabs", "RecommendationsAutoCreateCustomTab", "RecommendationsCustomTabJeOwned", "Recommendations", "<div class=\"jellyfinenhanced recommendations\"></div>"),
            ("ActivityFeedEnabled", "ActivityFeedUseCustomTabs", "ActivityFeedAutoCreateCustomTab", "ActivityFeedCustomTabJeOwned", "Activity", "<div class=\"jellyfinenhanced activity\"></div>"),
            ("CatchUpEnabled", "CatchUpUseCustomTabs", "CatchUpAutoCreateCustomTab", "CatchUpCustomTabJeOwned", "Catch Up", "<div class=\"jellyfinenhanced catchup\"></div>"),
        };

        private readonly MaintenanceModeService _maintenance;
        private readonly IPluginManager? _plugins;
        private readonly Logger _logger;
        private readonly object _sync = new();
        // Reconciles asked for (each Request adds one) and done; a pass covers every request made before it began.
        private long _requested;
        private long _done;
        private Task? _running;
        private ConfigurationEffectsOutcome? _last;
        private readonly List<(long Pass, TaskCompletionSource<ConfigurationEffectsOutcome> Done)> _waiters = new();

        /// <summary>Creates the owner.</summary>
        public ConfigurationEffects(MaintenanceModeService maintenance, IPluginManager? plugins, Logger logger)
        {
            _maintenance = maintenance;
            _plugins = plugins;
            _logger = logger;
        }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            Instance = this;
            // What the stored configuration asks for is applied once at start-up too (a restart in between two writes).
            Request();
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public Task StopAsync(CancellationToken cancellationToken)
        {
            if (ReferenceEquals(Instance, this)) Instance = null;
            return Task.CompletedTask;
        }

        /// <summary>The fields the effects follow, to tell whether a field writer changed them (maintenance, Custom Tabs intent).</summary>
        internal static string EffectFingerprint(PluginConfiguration? cfg)
        {
            if (cfg == null) return string.Empty;
            var tabs = ManagedTabs.Select(t => string.Join(",", Flag(cfg, t.Master), Flag(cfg, t.Parent), Flag(cfg, t.Auto)));
            return MaintenanceDesired.Of(cfg).Fingerprint() + "|" + string.Join(";", tabs);
        }

        /// <summary>
        /// Asks for a reconcile from the configuration held when it runs. Never waits (safe under the configuration lock).
        /// </summary>
        /// <returns>The pass that will cover this request.</returns>
        public long Request()
        {
            lock (_sync)
            {
                var pass = ++_requested;
                if (_running == null) _running = Task.Run(RunAsync);
                return pass;
            }
        }

        /// <summary>
        /// Asks for a reconcile and waits, at most <paramref name="timeout"/>, for the pass covering it. The outcome says, for the
        /// caller's <paramref name="generation"/>: applied (the effects follow it), superseded (a newer configuration's effects
        /// apply instead) or failed; pending when the wait ran out (the reconcile still runs).
        /// </summary>
        public async Task<ConfigurationEffectsOutcome> ReconcileAsync(long generation, TimeSpan timeout)
        {
            var waiter = new TaskCompletionSource<ConfigurationEffectsOutcome>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (_sync)
            {
                var pass = ++_requested;
                _waiters.Add((pass, waiter));
                if (_running == null) _running = Task.Run(RunAsync);
            }
            var finished = await Task.WhenAny(waiter.Task, Task.Delay(timeout)).ConfigureAwait(false);
            if (finished != waiter.Task) return new ConfigurationEffectsOutcome(generation, "pending", null);
            var outcome = await waiter.Task.ConfigureAwait(false);
            if (outcome.Maintenance == "failed") return outcome;
            return outcome.Generation > generation ? outcome with { Maintenance = "superseded" } : outcome;
        }

        /// <summary>The last reconcile's outcome (diagnostics, tests).</summary>
        internal ConfigurationEffectsOutcome? Last
        {
            get { lock (_sync) return _last; }
        }

        private async Task RunAsync()
        {
            while (true)
            {
                long pass;
                lock (_sync)
                {
                    if (_done >= _requested)
                    {
                        _running = null;
                        return;
                    }
                    pass = _requested;
                }
                ConfigurationEffectsOutcome outcome;
                try
                {
                    outcome = await ReconcileOnceAsync().ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    _logger.Warning($"[Configuration] Applying the configuration's effects failed: {ex.Message}");
                    outcome = new ConfigurationEffectsOutcome(CurrentGeneration(), "failed", null);
                }
                List<TaskCompletionSource<ConfigurationEffectsOutcome>> finished;
                lock (_sync)
                {
                    _done = Math.Max(_done, pass);
                    _last = outcome;
                    finished = _waiters.Where(w => w.Pass <= pass).Select(w => w.Done).ToList();
                    _waiters.RemoveAll(w => w.Pass <= pass);
                }
                foreach (var done in finished) done.TrySetResult(outcome);
            }
        }

        /// <summary>The configuration's generation now.</summary>
        private static long CurrentGeneration()
        {
            lock (JellyfinEnhanced.ConfigurationLock) return JellyfinEnhanced.Instance?.Configuration?.ConfigurationGeneration ?? 0;
        }

        /// <summary>What maintenance mode is asked to be now (read under the configuration lock, briefly).</summary>
        private static MaintenanceDesired? CurrentDesired()
        {
            lock (JellyfinEnhanced.ConfigurationLock)
            {
                var cfg = JellyfinEnhanced.Instance?.Configuration;
                return cfg == null ? null : MaintenanceDesired.Of(cfg);
            }
        }

        private async Task<ConfigurationEffectsOutcome> ReconcileOnceAsync()
        {
            // A failure throws (the pass reports "failed"); a pass that ran is applied for the generation it read.
            var reconciled = await _maintenance.ReconcileAsync(CurrentDesired).ConfigureAwait(false);
            const string maintenance = "applied";
            if (reconciled is { Opened: true, Superseded: false })
            {
                // The window this configuration opened is announced once, by its own reconcile (never by an older one).
                var desired = CurrentDesired();
                if (desired != null && desired.Generation == reconciled.Generation && desired.Enabled)
                {
                    var text = FirstNonBlank(desired.NotificationMessage, desired.Message, MaintenanceModeService.DefaultNotificationText);
                    try
                    {
                        var result = await _maintenance.BroadcastAsync(MaintenanceModeService.DefaultHeader, text, 30000, string.Empty).ConfigureAwait(false);
                        _logger.Info($"[Maintenance] Window-start notification sent to {result.Sent} session(s), skipped {result.Skipped}.");
                    }
                    catch (Exception ex)
                    {
                        _logger.Warning($"[Maintenance] Window-start notification failed: {ex.Message}");
                    }
                }
            }
            var tabs = SyncCustomTabs();
            return new ConfigurationEffectsOutcome(reconciled?.Generation ?? CurrentGeneration(), maintenance, tabs);
        }

        /// <summary>
        /// Syncs the Custom Tabs entries Jellyfin Enhanced manages with what the configuration held now asks for: an entry all
        /// three flags ask for and Custom Tabs lacks is added (and recorded as Jellyfin Enhanced's); one Jellyfin Enhanced added
        /// whose flags are off is removed; an entry an administrator made by hand is never removed (Jellyfin Enhanced doesn't
        /// own it). The ownership flags written back are facts about what this sync did, applied to the configuration held
        /// when they are written. When the configuration changes between the read and the Custom Tabs write, nothing is
        /// written (the reconcile that change asked for syncs it). Custom Tabs not installed: skipped (the intent is kept).
        /// </summary>
        internal CustomTabsSyncOutcome? SyncCustomTabs()
        {
            PluginConfiguration? cfg;
            long generation;
            lock (JellyfinEnhanced.ConfigurationLock)
            {
                cfg = JellyfinEnhanced.Instance?.Configuration;
                if (cfg == null) return null;
                generation = cfg.ConfigurationGeneration;
                cfg = ConfigurationPatcher.Clone(cfg);
            }
            var anyIntent = ManagedTabs.Any(t => Flag(cfg, t.Master) && Flag(cfg, t.Parent) && Flag(cfg, t.Auto));
            var anyOwned = ManagedTabs.Any(t => Flag(cfg, t.Owned));
            IHasPluginConfiguration? host = null;
            try
            {
                host = _plugins?.Plugins.FirstOrDefault(p => p.Id == CustomTabsPluginId && p.Instance != null)?.Instance as IHasPluginConfiguration;
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Custom Tabs] Could not look for the Custom Tabs plugin: {ex.Message}");
            }
            if (host == null)
            {
                return new CustomTabsSyncOutcome(true, "skipped", "Custom Tabs not installed; nothing to sync.");
            }
            if (!anyIntent && !anyOwned) return new CustomTabsSyncOutcome(true, "noop", "Custom Tabs already in sync.");

            JsonObject? document;
            try
            {
                document = JsonSerializer.SerializeToNode(host.Configuration, host.ConfigurationType) as JsonObject;
            }
            catch (Exception ex)
            {
                return new CustomTabsSyncOutcome(false, "failed", "Could not read Custom Tabs configuration: " + ex.Message);
            }
            if (document?["Tabs"] is not JsonArray tabs || tabs.Any(t => t is not JsonObject o || o["Title"]?.GetValueKind() != JsonValueKind.String || o["ContentHtml"]?.GetValueKind() != JsonValueKind.String))
            {
                return new CustomTabsSyncOutcome(false, "failed", "Custom Tabs configuration shape no longer matches what Jellyfin Enhanced knows how to write; auto-manage skipped to avoid corrupting it.");
            }

            var changed = false;
            var owned = new Dictionary<string, bool>();
            foreach (var entry in ManagedTabs)
            {
                var shouldExist = Flag(cfg, entry.Master) && Flag(cfg, entry.Parent) && Flag(cfg, entry.Auto);
                var isOwned = Flag(cfg, entry.Owned);
                var index = -1;
                for (var i = 0; i < tabs.Count; i++)
                {
                    if (string.Equals(tabs[i]?["ContentHtml"]?.GetValue<string>(), entry.Html, StringComparison.Ordinal)) { index = i; break; }
                }
                if (shouldExist && index == -1)
                {
                    tabs.Add(new JsonObject { ["Title"] = entry.Title, ["ContentHtml"] = entry.Html });
                    changed = true;
                    owned[entry.Owned] = true;
                }
                else if (!shouldExist && index != -1 && isOwned)
                {
                    tabs.RemoveAt(index);
                    changed = true;
                    owned[entry.Owned] = false;
                }
                else if (!shouldExist && index == -1 && isOwned)
                {
                    // Removed by hand meanwhile: nothing left that Jellyfin Enhanced owns.
                    owned[entry.Owned] = false;
                }
            }
            if (!changed && owned.Count == 0) return new CustomTabsSyncOutcome(true, "noop", "Custom Tabs already in sync.");

            if (changed)
            {
                // The plan was made from generation G: a configuration written since is synced by its own reconcile.
                if (CurrentGeneration() != generation) return new CustomTabsSyncOutcome(true, "superseded", "A newer configuration is being synced.");
                try
                {
                    var next = (MediaBrowser.Model.Plugins.BasePluginConfiguration?)document.Deserialize(host.ConfigurationType);
                    if (next == null) throw new InvalidOperationException("the configuration could not be built");
                    host.UpdateConfiguration(next);
                }
                catch (Exception ex)
                {
                    _logger.Warning($"[Custom Tabs] Could not update the Custom Tabs entries: {ex.Message}");
                    return new CustomTabsSyncOutcome(false, "failed", "Custom Tabs update failed: " + ex.Message);
                }
            }

            try
            {
                // What this sync did, recorded on the configuration held now (another write meanwhile keeps its own changes).
                JellyfinEnhanced.Instance?.MutateConfiguration(live =>
                {
                    var any = false;
                    foreach (var (field, value) in owned)
                    {
                        var property = typeof(PluginConfiguration).GetProperty(field);
                        if (property == null || (bool)(property.GetValue(live) ?? false) == value) continue;
                        property.SetValue(live, value);
                        any = true;
                    }
                    return any;
                });
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Custom Tabs] The entries were updated, but recording which ones Jellyfin Enhanced owns failed: {ex.Message}");
                return new CustomTabsSyncOutcome(false, "failed", "Custom Tabs was updated, but Jellyfin Enhanced could not record which entries it manages. Turn the Custom Tabs auto-create options off and on again, then save.");
            }
            return new CustomTabsSyncOutcome(true, changed ? "ok" : "noop", changed ? "Custom Tabs updated." : "Custom Tabs already in sync.");
        }

        private static bool Flag(PluginConfiguration cfg, string name)
            => typeof(PluginConfiguration).GetProperty(name)?.GetValue(cfg) is true;

        private static string FirstNonBlank(params string?[] values)
        {
            foreach (var v in values)
            {
                if (!string.IsNullOrWhiteSpace(v)) return v.Trim();
            }
            return string.Empty;
        }
    }
}
