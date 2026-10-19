using System;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Home
{
    /// <summary>
    /// The effective home-row and collection-gap switches. Every one needs Requests &amp; downloads, phase 1, phase 3 and
    /// phase 4, then its own administrator switch (all off by default). Routes, the Home Screen Sections results and the
    /// client all read these; the client never decides on its own.
    /// </summary>
    public static class HomeFlags
    {
        /// <summary>Home rows are on (parents and the home-rows switch).</summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether home rows are on.</returns>
        public static bool Rows(PluginConfiguration? config) => AutomationFlags.Phase4WithRequests(config) && config!.ArrPhase4HomeRowsEnabled;

        /// <summary>
        /// The rows are registered as Home Screen Sections sections (the switch; whether the plugin is installed is
        /// <see cref="HssSectionsAdapter.Present"/>). Titles not in the library are shown there through the native pages
        /// for them, so those must be on too (Jellyfin 12 only).
        /// </summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether the sections are on.</returns>
        public static bool HssSections(PluginConfiguration? config) => Rows(config) && config!.ArrPhase4HssSectionsEnabled && NativePages(config);

        /// <summary>The administrator's strip (it reads the arr admin hub's facts, so it needs phase 2 too).</summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether the strip is on.</returns>
        public static bool OpsStrip(PluginConfiguration? config) => Rows(config) && config!.ArrPhase4HomeOpsStripEnabled && JellyfinBridge.Phase2(config);

        /// <summary>The phase 4 additions to collection gaps (list-entry coverage, no second Seerr row).</summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether they are on.</returns>
        public static bool CollectionGaps(PluginConfiguration? config) => AutomationFlags.Phase4WithRequests(config) && config!.ArrPhase4CollectionGapsEnabled;

        /// <summary>The native pages for titles not in the library are on (they exist on Jellyfin 12 only).</summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether they are on.</returns>
        public static bool NativePages(PluginConfiguration? config)
        {
#if JF12
            return NativeDetails.NativeDetailsPolicy.FeatureEnabled(config) && NativeDetails.NativeDetailsPolicy.SeerrConfigured(config!);
#else
            return false;
#endif
        }
    }

    /// <summary>Which home rows one person sees.</summary>
    /// <param name="Requests">"Your requests".</param>
    /// <param name="Soon">"Coming soon for you".</param>
    /// <param name="Arrived">"Just arrived for you".</param>
    /// <param name="Ops">The administrator's strip (still needs the person to be an administrator).</param>
    public readonly record struct HomeRowChoice(bool Requests, bool Soon, bool Arrived, bool Ops)
    {
        /// <summary>No row at all.</summary>
        public bool None => !Requests && !Soon && !Arrived;

        /// <summary>The rows from the effective switches and the person's preferences (null follows the administrator, false hides).</summary>
        /// <param name="config">Configuration.</param>
        /// <param name="preferences">The person's preferences.</param>
        /// <returns>The rows.</returns>
        public static HomeRowChoice Of(PluginConfiguration? config, HomePreferences preferences)
        {
            var rows = HomeFlags.Rows(config);
            return new HomeRowChoice(
                rows && preferences.Requests != false,
                rows && preferences.Soon != false,
                rows && preferences.Arrived != false,
                HomeFlags.OpsStrip(config) && preferences.Ops != false);
        }
    }

    /// <summary>A person's home-row preferences, each null when never chosen.</summary>
    /// <param name="Requests">"Your requests".</param>
    /// <param name="Soon">"Coming soon for you".</param>
    /// <param name="Arrived">"Just arrived for you".</param>
    /// <param name="Ops">The administrator's strip.</param>
    public readonly record struct HomePreferences(bool? Requests, bool? Soon, bool? Arrived, bool? Ops);

    /// <summary>A person's home-row preferences (read on the server, never from a request body).</summary>
    public interface IHomePreferences
    {
        /// <summary>The person's preferences.</summary>
        /// <param name="user">The person.</param>
        /// <returns>The preferences.</returns>
        HomePreferences For(Guid user);
    }

    /// <summary>Home-row preferences from each person's Jellyfin Enhanced settings (<c>settings.json</c>).</summary>
    public sealed class UserSettingsHomePreferences : IHomePreferences
    {
        private readonly UserConfigurationManager _users;

        /// <summary>Creates the reader (DI).</summary>
        /// <param name="users">User settings.</param>
        public UserSettingsHomePreferences(UserConfigurationManager users) { _users = users; }

        /// <inheritdoc />
        public HomePreferences For(Guid user)
        {
            var settings = _users.GetUserConfiguration<JellyfinEnhancedUserSettings>(user.ToString("N"), "settings.json");
            return new HomePreferences(settings.HomeRowRequests, settings.HomeRowSoon, settings.HomeRowArrived, settings.HomeOpsStrip);
        }
    }
}
