using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;

namespace JE.Tests.Features.MediaTags;

/// <summary>The deletion requests the Leaving soon page lists keep what Reclaimerr says they would delete and how they ended (upstream 40738412).</summary>
public class ReclaimerrRequestRowTests
{
    [Fact]
    public void A_request_keeps_its_scope_version_and_failure_so_the_page_never_shows_a_season_as_a_whole_title()
    {
        const string json = """
        [
          { "id": 1, "media_title": "Sherlock", "media_year": 2010, "media_type": "series", "target_scope": "season", "season_number": 2,
            "requested_by_username": "sam_user", "reason": "Requested by Sam from Jellyfin: boring", "status": "pending", "created_at": "2026-11-16T10:00:00Z", "media_id": 9 },
          { "id": 2, "media_title": "Jailer 2", "media_year": 2026, "media_type": "movie", "movie_version_id": 4, "version_resolution": "2160p", "version_size": 3221225472,
            "requested_by_username": "x", "status": "approved", "execution_error": "Radarr refused", "created_at": "2026-11-16T10:00:00Z", "media_id": 3 },
          { "id": 3, "media_title": "Crash", "media_type": "movie", "requested_by_username": "x", "status": "approved", "playback_deferral": { "until": "later" }, "executed_at": null, "created_at": "2026-11-16T10:00:00Z" },
          { "id": 4, "media_title": "Old", "media_type": "series", "requested_by_username": "x", "status": "approved", "playback_deferral": { "until": "later" }, "executed_at": "2026-11-17T00:00:00Z", "created_at": "2026-11-16T10:00:00Z" }
        ]
        """;
        using var doc = JsonDocument.Parse(json);
        var rows = ReclaimerrActions.Parse(doc, null);

        Assert.Equal(4, rows.Count);
        Assert.Equal(("season", 2, null), (rows[0].Scope, rows[0].SeasonNumber, rows[0].EpisodeNumber));
        Assert.Equal("movie", rows[1].Scope);
        Assert.Equal(("2160p", 3221225472L, "Radarr refused"), (rows[1].VersionResolution, rows[1].VersionSize, rows[1].ExecutionError));
        Assert.True(rows[2].Deferred, "held back by playback and not yet executed");
        Assert.False(rows[3].Deferred, "a deferral that has since run is history");
        Assert.Equal("series", rows[3].Scope);
    }

    [Fact]
    public void The_filter_keeps_only_approved_requests_that_failed_or_are_held_back()
    {
        const string json = """
        [
          { "id": 1, "media_title": "Fine", "media_type": "movie", "status": "approved", "executed_at": "2026-11-17T00:00:00Z" },
          { "id": 2, "media_title": "Broken", "media_type": "movie", "status": "approved", "execution_error": "boom" }
        ]
        """;
        using var doc = JsonDocument.Parse(json);
        var rows = ReclaimerrActions.Parse(doc, r => !string.IsNullOrEmpty(r.ExecutionError) || r.Deferred);
        Assert.Equal(new[] { 2 }, rows.Select(r => r.Id).ToArray());
    }
}
