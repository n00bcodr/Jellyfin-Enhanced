using System;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation
{
    /// <summary>
    /// A person's consent to a recipe asking on their behalf (read on the server, never from a request body). The
    /// existing recipes (next season, next movie) follow the administrator unless the person opted out (null = follow);
    /// every new recipe needs the person's explicit yes (null = no).
    /// </summary>
    public interface IAutomationConsents
    {
        /// <summary>The person's stored preference for the recipe: true, false, or null (never chosen).</summary>
        /// <param name="user">The person.</param>
        /// <param name="recipe">Recipe id.</param>
        bool? Preference(Guid user, string recipe);
    }

    /// <summary>The consent rule over a preference.</summary>
    public static class AutomationConsent
    {
        /// <summary>True when the recipe may ask for the person: legacy recipes unless opted out, new ones only when opted in.</summary>
        /// <param name="consents">Preferences.</param>
        /// <param name="user">The person.</param>
        /// <param name="recipe">Recipe id.</param>
        public static bool Allows(IAutomationConsents? consents, Guid user, string recipe)
        {
            var preference = consents?.Preference(user, recipe);
            return AutomationRecipes.IsLegacy(recipe) ? preference != false : preference == true;
        }
    }

    /// <summary>Preferences from each person's Jellyfin Enhanced settings (<c>settings.json</c>).</summary>
    public sealed class UserSettingsConsents : IAutomationConsents
    {
        private readonly UserConfigurationManager _users;

        /// <summary>Creates the reader (DI).</summary>
        public UserSettingsConsents(UserConfigurationManager users) { _users = users; }

        /// <inheritdoc />
        public bool? Preference(Guid user, string recipe)
        {
            var settings = _users.GetUserConfiguration<UserSettings>(user.ToString("N"), "settings.json");
            return recipe switch
            {
                AutomationRecipes.AutoSeason => settings.AutoSeasonRequests,
                AutomationRecipes.AutoMovie => settings.AutoMovieRequests,
                _ => null,
            };
        }
    }
}
