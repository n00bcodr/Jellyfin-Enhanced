using System;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>Where a per-user setting can take effect.</summary>
    public enum SettingReach
    {
        /// <summary>Only JE's injected web UI (which also runs in Jellyfin for Android and webOS).</summary>
        Web,

        /// <summary>Only the server's native poster stamping.</summary>
        Server,

        /// <summary>The web UI and, through PosterTagSettings, native poster images.</summary>
        Both,
    }

    /// <summary>
    /// Registry entry for a <see cref="UserSettings"/> property: which admin setting holds its
    /// default, whether an admin can lock it, and how its values are validated. Read once by
    /// <see cref="UserSettingsRegistry"/> through reflection, the way [AnalyticsInclude] and
    /// [AnalyticsExclude] mark PluginConfiguration properties. Every UserSettings property
    /// carries one, or is listed in <see cref="UserSettingsRegistry.NotRegistered"/>.
    /// </summary>
    [AttributeUsage(AttributeTargets.Property)]
    public sealed class UserSettingAttribute : Attribute
    {
        /// <summary>Initializes a new instance of the <see cref="UserSettingAttribute"/> class.</summary>
        /// <param name="adminDefault">The PluginConfiguration property holding the admin default (use nameof), or null when there is none.</param>
        public UserSettingAttribute(string? adminDefault = null) => AdminDefault = adminDefault;

        /// <summary>Gets the PluginConfiguration property holding the admin default, or null for a user-only key.</summary>
        public string? AdminDefault { get; }

        /// <summary>Gets or sets a value indicating whether an admin can lock the key to its default (needs a resolvable admin control).</summary>
        public bool Lockable { get; set; }

        /// <summary>Gets or sets a value indicating whether the key can follow its admin default (false when there is no admin counterpart).</summary>
        public bool Inheritable { get; set; } = true;

        /// <summary>Gets or sets where the key can take effect; the effective reach also depends on the config.</summary>
        public SettingReach Reach { get; set; } = SettingReach.Web;

        /// <summary>Gets or sets a value indicating whether the key is set by a slider or colour picker (saves are debounced).</summary>
        public bool Continuous { get; set; }

        /// <summary>Gets or sets a value indicating whether the key is written as a side effect of browsing (a set equal to the default follows it again).</summary>
        public bool Incidental { get; set; }

        /// <summary>Gets or sets a value indicating whether a stored null means "use the admin value" (legacy *TagOrder).</summary>
        public bool NullInheritsAdmin { get; set; }

        /// <summary>Gets or sets a value indicating whether a stored empty string means "use the admin value" (legacy *TagsPosition, preferred audio language).</summary>
        public bool EmptyInheritsAdmin { get; set; }

        /// <summary>
        /// Gets or sets a value indicating whether the default this key gets from the admin is its sentinel
        /// (the null or empty value that already inherits) rather than a copy of the admin value; the
        /// seed then writes the sentinel. Needs <see cref="NullInheritsAdmin"/> or <see cref="EmptyInheritsAdmin"/>.
        /// </summary>
        public bool DefaultIsSentinel { get; set; }

        /// <summary>Gets or sets a value indicating whether a blank admin value gives the C# initializer instead.</summary>
        public bool BlankAdminUsesInitializer { get; set; }

        /// <summary>Gets or sets the admin bool that must be on for the key to have any effect (the panel explains why when it is off).</summary>
        public string? GateBy { get; set; }

        /// <summary>Gets or sets the smallest accepted value of an int key.</summary>
        public int Min { get; set; } = int.MinValue;

        /// <summary>Gets or sets the largest accepted value of an int key.</summary>
        public int Max { get; set; } = int.MaxValue;

        /// <summary>Gets or sets the fixed set of accepted values of a string key.</summary>
        public string[]? Choices { get; set; }

        /// <summary>Gets or sets the regular expression a string value must match.</summary>
        public string? Pattern { get; set; }

        /// <summary>Gets or sets the longest accepted string value.</summary>
        public int MaxLength { get; set; } = 64;

        /// <summary>Gets or sets the admin page control id when it is not camelCase(<see cref="AdminDefault"/>).</summary>
        public string? AdminControlId { get; set; }

        /// <summary>Gets or sets the admin page row (data-order-key) that edits the default, for keys without an input of their own.</summary>
        public string? AdminRowKey { get; set; }
    }
}
