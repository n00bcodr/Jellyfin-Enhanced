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
        private readonly AutoMovieRequestMonitor _autoMovieRequestMonitor;
        private readonly WatchlistMonitor _watchlistMonitor;

        public string Name => "Jellyfin Enhanced Startup";
        public string Key => "JellyfinEnhancedStartup";
        public string Description => "Injects the Jellyfin Enhanced script using the File Transformation plugin and performs necessary cleanups.";
        public string Category => "Jellyfin Enhanced";

        public StartupService(Logger logger, IApplicationPaths applicationPaths, AutoSeasonRequestMonitor autoSeasonRequestMonitor, AutoMovieRequestMonitor autoMovieRequestMonitor, WatchlistMonitor watchlistMonitor)
        {
            _logger = logger;
            _applicationPaths = applicationPaths;
            _autoSeasonRequestMonitor = autoSeasonRequestMonitor;
            _autoMovieRequestMonitor = autoMovieRequestMonitor;
            _watchlistMonitor = watchlistMonitor;
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            await Task.Run(() =>
            {
                _logger.Info("Jellyfin Enhanced Startup Task run successfully.");
                RegisterFileTransformation();

                // Initialize auto season request monitoring
                _autoSeasonRequestMonitor.Initialize();

                // Initialize auto movie request monitoring
                _autoMovieRequestMonitor.Initialize();

                // Initialize watchlist monitoring
                _watchlistMonitor.Initialize();

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
                RegisterAssetTransformations(fileTransformationAssembly);
            }
            else
            {
                _logger.Info("File Transformation Plugin not found. Using fallback injection method.");
                JellyfinEnhanced.Instance?.InjectScript();
            }
        }

        private void RegisterAssetTransformations(Assembly fileTransformationAssembly)
        {
            try
            {
                Type? pluginType = fileTransformationAssembly.GetType("Jellyfin.Plugin.FileTransformation.FileTransformationPlugin");
                PropertyInfo? instanceProperty = pluginType?.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static);
                object? pluginInstance = instanceProperty?.GetValue(null);
                PropertyInfo? serviceProviderProperty = pluginType?.GetProperty("ServiceProvider", BindingFlags.Public | BindingFlags.Instance);
                object? serviceProviderValue = serviceProviderProperty?.GetValue(pluginInstance);

                if (serviceProviderValue is not IServiceProvider serviceProvider)
                {
                    _logger.Info("File Transformation Plugin located, but service provider unavailable. Skipping logo replacement registration.");
                    return;
                }

                Type? writeServiceType = fileTransformationAssembly.GetType("Jellyfin.Plugin.FileTransformation.Library.IWebFileTransformationWriteService");
                Type? transformDelegateType = fileTransformationAssembly.GetType("Jellyfin.Plugin.FileTransformation.Library.TransformFile");
                MethodInfo? addTransformationMethod = writeServiceType?.GetMethod("AddTransformation");

                if (writeServiceType == null || transformDelegateType == null || addTransformationMethod == null)
                {
                    _logger.Info("File Transformation Plugin types not found. Skipping logo replacement registration.");
                    return;
                }

                object? writeService = serviceProvider.GetService(writeServiceType);
                if (writeService == null)
                {
                    _logger.Info("Could not resolve IWebFileTransformationWriteService. Skipping logo replacement registration.");
                    return;
                }

                RegisterAssetTransformation(writeService, addTransformationMethod, transformDelegateType,
                    Guid.Parse("c207f6d2-67a7-4a63-9c50-7f7e2c6f2b0a"),
                    ".*icon-transparent.*\\.png$",
                    nameof(TransformationPatches.IconTransparent));

                RegisterAssetTransformation(writeService, addTransformationMethod, transformDelegateType,
                    Guid.Parse("6f4b2e4b-6273-4a2d-b1ea-42c0d8f90c01"),
                    ".*banner-light.*\\.png$",
                    nameof(TransformationPatches.BannerLight));

                RegisterAssetTransformation(writeService, addTransformationMethod, transformDelegateType,
                    Guid.Parse("a1aa3c3d-5e9f-4b45-bda0-43be64dae124"),
                    ".*banner-dark.*\\.png$",
                    nameof(TransformationPatches.BannerDark));

                RegisterAssetTransformation(writeService, addTransformationMethod, transformDelegateType,
                    Guid.Parse("d5b8f4c2-9a1e-4f7b-8c3d-7e2a5b9c1d4f"),
                    ".*favicon.*\\.ico$",
                    nameof(TransformationPatches.Favicon));

                RegisterAssetTransformation(writeService, addTransformationMethod, transformDelegateType,
                    Guid.Parse("a8f3b2b3-7c9d-4c0f-9f2a-1c2d3e4f5a67"),
                    ".*touchicon\\.f5bbb798cb2c65908633\\.png$",
                    nameof(TransformationPatches.AppleIcon));

                _logger.Info("Registered Jellyfin Enhanced Custom Branding with File Transformation Plugin.");
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to register Custom Branding via File Transformation Plugin: {ex.Message}");
            }
        }

        private void RegisterAssetTransformation(object writeService, MethodInfo addTransformationMethod, Type delegateType, Guid id, string pathPattern, string callbackName)
        {
            MethodInfo? callbackMethod = typeof(TransformationPatches).GetMethod(callbackName, BindingFlags.Public | BindingFlags.Static);
            if (callbackMethod == null)
            {
                _logger.Warning($"Could not find callback '{callbackName}' for asset replacement.");
                return;
            }

            try
            {
                Delegate transformDelegate = Delegate.CreateDelegate(delegateType, callbackMethod);
                addTransformationMethod.Invoke(writeService, new object?[] { id, pathPattern, transformDelegate });
                _logger.Info($"Registered asset replacement for pattern '{pathPattern}' with ID {id:D}.");
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to register asset replacement for pattern '{pathPattern}': {ex.Message}");
            }
        }


        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            yield return new TaskTriggerInfo()
            {
                Type = TaskTriggerInfoType.StartupTrigger
            };
        }
    }
}