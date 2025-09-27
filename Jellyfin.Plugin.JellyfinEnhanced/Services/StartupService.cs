using System;
using System.IO;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    public class StartupService : IScheduledTask
    {
        private readonly ILogger<StartupService> _logger;
        private readonly IApplicationPaths _applicationPaths;

        public string Name => "Jellyfin Enhanced Startup";
        public string Key => "JellyfinEnhancedStartup";
        public string Description => "Injects the Jellyfin Enhanced script using the File Transformation plugin and performs necessary cleanups.";
        public string Category => "Startup Services";

        public StartupService(ILogger<StartupService> logger, IApplicationPaths applicationPaths)
        {
            _logger = logger;
            _applicationPaths = applicationPaths;
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            await Task.Run(() =>
            {
                RegisterFileTransformation();
                if (JellyfinEnhanced.Instance != null && JellyfinEnhanced.Instance.Configuration.WatchlistEnabled)
                {
                    RegisterWatchlistHomeSection();
                }
            }, cancellationToken);
        }

        private void RegisterFileTransformation()
        {
            Assembly? fileTransformationAssembly =
                AssemblyLoadContext.All.SelectMany(x => x.Assemblies).FirstOrDefault(x =>
                    x.FullName?.Contains(".FileTransformation") ?? false);

            if (fileTransformationAssembly != null)
            {
                Type? pluginInterfaceType = fileTransformationAssembly.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");

                if (pluginInterfaceType != null)
                {
                    var payload = new JObject
                    {
                        { "id", "f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b" }, // Using the plugin's GUID as a unique ID
                        { "fileNamePattern", "index.html" },
                        { "callbackAssembly", GetType().Assembly.FullName },
                        { "callbackClass", typeof(TransformationPatches).FullName },
                        { "callbackMethod", nameof(TransformationPatches.IndexHtml) }
                    };

                    pluginInterfaceType.GetMethod("RegisterTransformation")?.Invoke(null, new object?[] { payload });
                    _logger.LogInformation("Successfully registered Jellyfin Enhanced script injection with the File Transformation plugin.");
                }
                else
                {
                    _logger.LogWarning("Could not find PluginInterface in FileTransformation assembly. Using fallback injection method.");
                    JellyfinEnhanced.Instance?.InjectScript();
                }
            }
            else
            {
                _logger.LogWarning("File Transformation plugin not found. Using fallback injection method.");
                JellyfinEnhanced.Instance?.InjectScript();
            }
        }

        private void RegisterWatchlistHomeSection()
        {
            Assembly? fileTransformationAssembly =
                AssemblyLoadContext.All.SelectMany(x => x.Assemblies).FirstOrDefault(x =>
                    x.FullName?.Contains(".HomeScreenSections") ?? false);
            if (fileTransformationAssembly == null)
            {
                _logger.LogWarning("HomeScreen plugin not found. Skipping Watchlist home section registration.");
                return;
            }
            
            Type? pluginInterfaceType = fileTransformationAssembly.GetType("Jellyfin.Plugin.HomeScreenSections.PluginInterface");
            if (pluginInterfaceType == null)
            {
                _logger.LogWarning("Could not find PluginInterface in HomeScreen assembly. Skipping Watchlist home section registration.");
                return;
            }

            JObject payload = new JObject()
            {
                { "id", "JellyfinEnhancedWatchlist"}, 
                { "displayText", "Watchlist"},
                { "limit", 1},
                { "resultsEndpoint", "/JellyfinEnhanced/watchlist"}
            };
            pluginInterfaceType.GetMethod("RegisterSection")?.Invoke(null, [payload]);
            _logger.LogInformation("Successfully registered Watchlist home section with the HomeScreen plugin.");
        }

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            yield return new TaskTriggerInfo
            {
                Type = TaskTriggerInfo.TriggerStartup
            };
        }
    }
}