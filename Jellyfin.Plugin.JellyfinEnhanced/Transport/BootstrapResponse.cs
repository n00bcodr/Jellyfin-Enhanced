using System;
using System.Collections.Generic;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Transport;

/// <summary>The authenticated, token-user scoped bootstrap wire contract.</summary>
public sealed class BootstrapResponse
{
    public required string Version { get; init; }
    public required string UserId { get; init; }
    public required BootstrapPublicConfig PublicConfig { get; init; }
    public required BootstrapPrivateConfig? PrivateConfig { get; init; }
    public required bool HasCustomTabs { get; init; }
    public required bool HasPluginPages { get; init; }
    public required BootstrapUserDocuments UserSettings { get; init; }
    public required IReadOnlyList<string>? ComponentScripts { get; init; }
    /// <summary>
    /// The "groups" array of js/component-groups.json (which modules load together and on
    /// demand), without its notes. Null when the file is unusable: the client then loads the
    /// whole manifest as one group.
    /// </summary>
    public required IReadOnlyList<BootstrapComponentGroup>? ComponentGroups { get; init; }
    public required BootstrapPrefetched Prefetched { get; init; }
}

/// <summary>One entry of js/component-groups.json, named as the file names it.</summary>
public sealed class BootstrapComponentGroup
{
    [System.Text.Json.Serialization.JsonPropertyName("id")]
    public required string Id { get; init; }
    [System.Text.Json.Serialization.JsonPropertyName("after")]
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<string>? After { get; init; }
    [System.Text.Json.Serialization.JsonPropertyName("modules")]
    public required IReadOnlyList<string> Modules { get; init; }
}

/// <summary>Null means the document could not be loaded, never an empty replacement.</summary>
public sealed class BootstrapUserDocuments
{
    public required BootstrapSettings? Settings { get; init; }
    public string? SettingsRevision { get; init; }
    public required UserShortcuts? Shortcuts { get; init; }
    public required UserBookmark? Bookmark { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public BookmarkDocumentResponse? BookmarkSnapshot { get; init; }
    public required ElsewhereSettings? Elsewhere { get; init; }
    public required UserHiddenContent? HiddenContent { get; init; }
}

/// <summary>Existing settings plus the request-derived administrator flag.</summary>
public sealed class BootstrapSettings : JellyfinEnhancedUserSettings
{
    public required bool IsAdmin { get; init; }
}

public sealed class BootstrapPrefetched
{
    public required UserSpoilerBlur? SpoilerBlurSeries { get; init; }
    // These feature-owned cached answers remain opaque JSON until their endpoint
    // contracts are migrated. Consumers must validate before accessing their fields.
    [OpaqueBootstrapJson]
    public required object? SeerrUserStatus { get; init; }
    [OpaqueBootstrapJson]
    public required object? SeerrStatus { get; init; }
    [OpaqueBootstrapJson]
    public required IReadOnlyList<object>? ActiveStreamSessions { get; init; }
    public required string? TagStripRevision { get; init; }
}

/// <summary>Explicit boundary for cached feature JSON that has not yet acquired a typed contract.</summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class OpaqueBootstrapJsonAttribute : Attribute { }

public sealed class RevisionedSettingsResponse
{
    public required string Revision { get; init; }
    public required BootstrapSettings Settings { get; init; }
}
public sealed class RevisionedSettingsRequest
{
    public required string Revision { get; init; }
    public required JellyfinEnhancedUserSettings Settings { get; init; }
}

public sealed class SettingsSaveReceipt
{
    public required string Revision { get; init; }
}
