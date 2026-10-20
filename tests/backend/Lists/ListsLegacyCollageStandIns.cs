using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests.LegacyCollageStandIns;

/// <summary>
/// Stand-ins with the JE actions' controller/action names and answer shapes; the real ones need the whole poster-tag,
/// activity and session stacks.
/// </summary>
[Route("JellyfinEnhanced")]
internal sealed class JellyfinEnhancedController(LegacyCollageScenario scenario) : ControllerBase
{
    [HttpGet("native-poster-tags/preview/{itemId}")]
    public IActionResult PreviewNativePosterTags(Guid itemId)
        => scenario.Items.TryGetValue(itemId, out var item) && item.GetImageInfo(ImageType.Primary, 0) is { } image
            ? File(System.IO.File.ReadAllBytes(image.Path), "image/jpeg")
            : NotFound(new { message = "Item has no Primary image." });

    // GetActivityFeed: rows whose Item is ActivityFeedBuilder's summary (a viewer can favourite a playlist or collection).
    [HttpGet("activity")]
    public IActionResult GetActivityFeed()
        => Ok(new
        {
            items = scenario.Names.Values.Select(id => scenario.Items[id]).Select(item => new
            {
                ActivityType = "favorited",
                UserName = "viewer",
                UserHasPrimaryImage = true,
                Item = new
                {
                    Id = item.Id.ToString("N"),
                    item.Name,
                    Type = item.GetBaseItemKind().ToString(),
                    HasPrimaryImage = item.HasImage(ImageType.Primary, 0),
                    HasThumbImage = item.HasImage(ImageType.Thumb, 0),
                    SeriesHasPrimaryImage = false,
                },
            }).ToList(),
        });

    // GetActiveSessions: BuildActiveSessionList's shape (ImageTags keyed by type name).
    [HttpGet("active-streams/sessions")]
    public IActionResult GetActiveSessions()
        => Ok(scenario.Names.Values.Select(id => scenario.Dto(id)).Select(dto => (object)new
        {
            UserName = "viewer",
            UserHasPrimaryImage = true,
            NowPlayingItem = new
            {
                Id = dto.Id.ToString("N"),
                Type = dto.Type.ToString(),
                dto.Name,
                ImageTags = dto.ImageTags?.ToDictionary(kv => kv.Key.ToString(), kv => kv.Value),
                SeriesPrimaryImageTag = (string?)null,
            },
        }).ToList());
}
