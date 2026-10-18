using System;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// The effective list switches: every child needs Requests &amp; downloads, phase 1, phase 3, phase 4 and
    /// <see cref="PluginConfiguration.ArrPhase4ListPlaceholdersEnabled"/>, then its own admin switch (all off by default).
    /// Routes and background work check these at execution, not only the client.
    /// </summary>
    public static class ListFlags
    {
        /// <summary>Lists are on (parents and the list switch).</summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether lists are on.</returns>
        public static bool Lists(PluginConfiguration? config) => AutomationFlags.Phase4WithRequests(config) && config!.ArrPhase4ListPlaceholdersEnabled;

        /// <summary>Adding, editing, linking, reordering, removing entries and creating lists.</summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether authoring is on.</returns>
        public static bool Authoring(PluginConfiguration? config) => Lists(config) && config!.ArrPhase4ListAuthoringEnabled;

        /// <summary>Requesting a list entry.</summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether list requests are on.</returns>
        public static bool Requests(PluginConfiguration? config) => Lists(config) && config!.ArrPhase4ListRequestsEnabled;

        /// <summary>Request all missing.</summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether Request all missing is on.</returns>
        public static bool RequestAll(PluginConfiguration? config) => Requests(config) && config!.ArrPhase4ListRequestAllEnabled;

        /// <summary>Automatic swap-in (still needs the list's consent and the consenting person's preference).</summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether swap-in is on.</returns>
        public static bool SwapIn(PluginConfiguration? config) => Lists(config) && config!.ArrPhase4ListSwapInEnabled;

        /// <summary>Daily maintenance (metadata refresh, missed arrivals).</summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether maintenance is on.</returns>
        public static bool Maintenance(PluginConfiguration? config) => Lists(config) && config!.ArrPhase4ListMaintenanceEnabled;

        /// <summary>Request status on list entries (admin switch; each person may still hide it).</summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether status is on.</returns>
        public static bool Status(PluginConfiguration? config) => Lists(config) && config!.ArrPhase4ListStatusEnabled;

        /// <summary>A display preference: null follows the administrator, false opts out.</summary>
        /// <param name="admin">The administrator's effective switch.</param>
        /// <param name="preference">The person's preference.</param>
        /// <returns>Whether it shows for the person.</returns>
        public static bool Display(bool admin, bool? preference) => admin && preference != false;

        /// <summary>A consent: only an explicit yes counts.</summary>
        /// <param name="admin">The administrator's effective switch.</param>
        /// <param name="preference">The person's preference.</param>
        /// <returns>Whether the person agreed.</returns>
        public static bool Consent(bool admin, bool? preference) => admin && preference == true;
    }

    /// <summary>A person's list preferences (read on the server, never from a request body).</summary>
    public interface IListPreferences
    {
        /// <summary>The person's preferences.</summary>
        /// <param name="user">The person.</param>
        /// <returns>(placeholders display, status display, swap-in consent), each null when never chosen.</returns>
        (bool? Placeholders, bool? Status, bool? SwapIn) For(Guid user);
    }

    /// <summary>List preferences from each person's Jellyfin Enhanced settings (<c>settings.json</c>).</summary>
    public sealed class UserSettingsListPreferences : IListPreferences
    {
        private readonly UserConfigurationManager _users;

        /// <summary>Creates the reader (DI).</summary>
        /// <param name="users">User settings.</param>
        public UserSettingsListPreferences(UserConfigurationManager users) { _users = users; }

        /// <inheritdoc />
        public (bool? Placeholders, bool? Status, bool? SwapIn) For(Guid user)
        {
            var settings = _users.GetUserConfiguration<JellyfinEnhancedUserSettings>(user.ToString("N"), "settings.json");
            return (settings.ListPlaceholders, settings.ListStatus, settings.ListSwapIn);
        }
    }
}
