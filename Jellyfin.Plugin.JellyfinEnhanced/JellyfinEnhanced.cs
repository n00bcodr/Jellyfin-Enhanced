using System.Globalization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using System.IO;
using System.Collections.Generic;
using System;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced
{
    public class JellyfinEnhanced : BasePlugin<PluginConfiguration>, IHasWebPages
    {
        private readonly IApplicationPaths _applicationPaths;
        private readonly Logger _logger;
        private const string PluginName = "Jellyfin Enhanced";

        public JellyfinEnhanced(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer, Logger logger) : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
            _applicationPaths = applicationPaths;
            _logger = logger;
            _logger.Info($"{PluginName} v{Version} initialized. Plugin logs will be written to: {_logger.CurrentLogFilePath}");
            CleanupOldScript();
        }

        public override string Name => PluginName;
        public override Guid Id => Guid.Parse("f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b");
        public static JellyfinEnhanced? Instance { get; private set; }

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

                var pluginFolderName = Path.GetFileNameWithoutExtension(configPath) ?? "Jellyfin.Plugin.JellyfinEnhanced";
                return Path.Combine(configDir, pluginFolderName, "custom_branding");
            }
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
                var scriptUrl = "../JellyfinEnhanced/script";
                var scriptTag = $"<script plugin=\"{Name}\" version=\"{Version}\" src=\"{scriptUrl}\" defer></script>";
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
                    DisplayName = "Jellyfin Enhanced",
                    EnableInMainMenu = true,
                    EmbeddedResourcePath = "Jellyfin.Plugin.JellyfinEnhanced.Configuration.configPage.html"
                    //Custom Icons are not supported - https://github.com/jellyfin/jellyfin-web/blob/38ac3355447a91bf280df419d745f5d49d05aa9b/src/apps/dashboard/components/drawer/sections/PluginDrawerSection.tsx#L61
                }
            };
        }
    }
}