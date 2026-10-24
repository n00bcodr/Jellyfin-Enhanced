using System;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Jellyfin's plugin-configuration route (POST /Plugins/{pluginId}/Configuration, PluginsController.UpdatePluginConfiguration)
    /// for JE's own configuration, after Jellyfin authorized the administrator:
    /// <list type="bullet">
    /// <item><description>a signed-in session posting there is a JE configuration page of an earlier build (the current page
    /// saves through PATCH /JellyfinEnhanced/configuration and never uses this route; an earlier page posts the whole
    /// configuration it filled from an older read, which would put back what changed since): refused before anything is
    /// applied (409 reload_required) and the session is told to reload (<see cref="ClientReloadNotice"/>);</description></item>
    /// <item><description>an API key's whole configuration goes to the plugin, which refuses one built on an earlier
    /// generation (<see cref="ConfigurationConflictException"/>): answered 409 configuration_conflict with the current
    /// generation instead of the host's generic error.</description></item>
    /// </list>
    /// Every other action, and other plugins' configurations, pass through untouched.
    /// </summary>
    public sealed class HostConfigurationRouteFilter : IAsyncActionFilter
    {
        /// <summary>JE's plugin id (JellyfinEnhanced.Id).</summary>
        internal static readonly Guid PluginId = Guid.Parse("f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b");

        private readonly ISessionManager? _sessions;
        private readonly Logger? _logger;

        /// <summary>Creates the filter (DI).</summary>
        public HostConfigurationRouteFilter(ISessionManager? sessions, Logger? logger = null)
        {
            _sessions = sessions;
            _logger = logger;
        }

        /// <summary>Whether an action is Jellyfin's configuration save of JE's configuration.</summary>
        internal static bool IsJeConfigurationSave(ActionExecutingContext context)
            => context.ActionDescriptor is ControllerActionDescriptor { ControllerName: "Plugins", ActionName: "UpdatePluginConfiguration" }
                && HttpMethods.IsPost(context.HttpContext.Request.Method)
                && context.ActionArguments.TryGetValue("pluginId", out var id) && id is Guid plugin && plugin == PluginId;

        /// <inheritdoc />
        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            // The pinned host's legacy startup endpoint mutates MetadataCountryCode in place, before SaveConfiguration;
            // it does not raise ConfigurationUpdating. Keep its whole action inside the same evidence writer barrier.
            if (context.ActionDescriptor is ControllerActionDescriptor { ControllerName: "Startup", ActionName: "UpdateInitialConfiguration" }
                && HttpMethods.IsPost(context.HttpContext.Request.Method))
            {
                using var writer = EvidenceRevision.Advance(_logger);
                await next().ConfigureAwait(false);
                return;
            }

            if (!IsJeConfigurationSave(context))
            {
                await next().ConfigureAwait(false);
                return;
            }

            if (ClientReloadNotice.FromSession(context.HttpContext.User))
            {
                _logger?.Info("Jellyfin Enhanced: refused a configuration save through Jellyfin's plugin-configuration route from an earlier JE settings page (reload it).");
                ClientReloadNotice.Send(_sessions, context.HttpContext.User, ClientReloadNotice.ConfigurationText, _logger);
                context.Result = new ObjectResult(new
                {
                    success = false,
                    code = "reload_required",
                    message = "This Jellyfin Enhanced settings page is from an earlier version, so nothing was saved. Reload the page and make your changes again.",
                })
                { StatusCode = StatusCodes.Status409Conflict };
                return;
            }

            var executed = await next().ConfigureAwait(false);
            if (executed.Exception is ConfigurationConflictException conflict && !executed.ExceptionHandled)
            {
                _logger?.Info($"Jellyfin Enhanced: refused a whole configuration built on generation {conflict.Sent} (now {conflict.Current}).");
                executed.ExceptionHandled = true;
                executed.Result = new ObjectResult(new
                {
                    success = false,
                    code = "configuration_conflict",
                    generation = conflict.Current,
                    message = conflict.Message,
                })
                { StatusCode = StatusCodes.Status409Conflict };
            }
        }
    }
}
