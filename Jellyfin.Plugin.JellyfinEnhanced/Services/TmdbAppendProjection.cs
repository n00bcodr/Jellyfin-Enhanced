using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>Explicit append contract. Unknown provider envelopes have no safe presentation adapter.</summary>
public static class TmdbAppendProjection
{
    /// <summary>Every allowed envelope has a shared standalone/appended projection and a contract test.</summary>
    public static IReadOnlyList<string> Envelopes { get; } = Array.AsReadOnly(new[] {
        "recommendations", "similar", "credits", "aggregate_credits", "images", "videos", "keywords",
        "content_ratings", "release_dates", "reviews", "watch/providers", "external_ids"
    });

    /// <summary>Validate decoded query values before fetching or reading any shared upstream cache.</summary>
    public static bool IsSupported(string path, IQueryCollection query)
    {
        // Queries smuggled inside the catch-all path bypass Request.Query and its decoded-key validation.
        if (path.IndexOfAny(new[] { '?', '%', '&', '#', ';', '=', '\\' }) >= 0) return false;
        foreach (var pair in query)
        {
            if (!pair.Key.Equals("append_to_response", StringComparison.OrdinalIgnoreCase)) continue;
            var parts = path.Trim('/').Split('/');
            if (parts.Length < 2 || HiddenContentPolicy.TitleIdentity(parts[0], parts[1]) == null) return false;
            // Only title, season and episode resources can own appended metadata; list/person scopes cannot.
            if (parts.Length != 2 && !(parts.Length == 4 && parts[2] == "season" && int.TryParse(parts[3], out _))
                && !(parts.Length == 6 && parts[2] == "season" && parts[4] == "episode" && int.TryParse(parts[3], out _) && int.TryParse(parts[5], out _))) return false;
            if (pair.Value.Count == 0) return false;
            foreach (var value in pair.Value)
                if (string.IsNullOrWhiteSpace(value) || value.Split(',').Any(envelope => !Envelopes.Contains(envelope, StringComparer.Ordinal))) return false;
        }
        return true;
    }
}
