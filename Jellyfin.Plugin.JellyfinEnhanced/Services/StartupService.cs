using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.JellyfinVersionSpecific;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    public class StartupService : IScheduledTask
    {
        private readonly Logger _logger;
        private readonly IApplicationPaths _applicationPaths;
        private readonly AutoSeasonRequestMonitor _autoSeasonRequestMonitor;

        public string Name => "Jellyfin Enhanced Startup";
        public string Key => "JellyfinEnhancedStartup";
        public string Description => "Injects the Jellyfin Enhanced script using the File Transformation plugin and performs necessary cleanups.";
        public string Category => "Jellyfin Enhanced";

        public StartupService(Logger logger, IApplicationPaths applicationPaths, AutoSeasonRequestMonitor autoSeasonRequestMonitor)
        {
            _logger = logger;
            _applicationPaths = applicationPaths;
            _autoSeasonRequestMonitor = autoSeasonRequestMonitor;
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            await Task.Run(() =>
            {
                _logger.Info("Jellyfin Enhanced Startup Task run successfully.");
                RegisterFileTransformation();

                // Initialize auto season request monitoring
                _autoSeasonRequestMonitor.Initialize();

                _logger.Info("Jellyfin Enhanced Startup Task completed successfully.");
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
                    _logger.Info("Successfully registered Jellyfin Enhanced Script Injection with File Transformation Plugin.");
                }
                else
                {
                    _logger.Info("Could not find PluginInterface in FileTransformation assembly. Using fallback injection method.");
                    JellyfinEnhanced.Instance?.InjectScript();
                }
            }
            else
            {
                _logger.Info("File Transformation Plugin not found. Using fallback injection method.");
                JellyfinEnhanced.Instance?.InjectScript();
            }
        }


        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() => StartupServiceHelper.GetDefaultTriggers();
    }
}