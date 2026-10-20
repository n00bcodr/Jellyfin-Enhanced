using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests.LegacyCollageStandIns;

/// <summary>A stand-in with the JE preview action's controller/action names; the real one needs the whole poster-tag stack.</summary>
[Route("JellyfinEnhanced")]
internal sealed class JellyfinEnhancedController(LegacyCollageScenario scenario) : ControllerBase
{
    [HttpGet("native-poster-tags/preview/{itemId}")]
    public IActionResult PreviewNativePosterTags(Guid itemId)
        => scenario.Items.TryGetValue(itemId, out var item) && item.GetImageInfo(ImageType.Primary, 0) is { } image
            ? File(System.IO.File.ReadAllBytes(image.Path), "image/jpeg")
            : NotFound(new { message = "Item has no Primary image." });
}
