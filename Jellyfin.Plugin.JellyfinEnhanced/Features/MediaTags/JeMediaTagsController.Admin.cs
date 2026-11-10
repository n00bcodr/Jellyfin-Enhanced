using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags
{
    // The Media Tags admin routes (formerly "AdminTags"; restructure S2.11, moved verbatim from JellyfinEnhancedController).
    public partial class JeMediaTagsController
    {
        /// <summary>
        /// What the config page's style editor draws from: the shipped default colours, every group's labels and
        /// each preset's palette (resolved to concrete colours, with the WCAG contrast of text over background).
        /// </summary>
        /// <returns>The catalog.</returns>
        [HttpGet("tag-styles/catalog")]
        [Authorize]
        public ActionResult GetTagStyleCatalog()
        {
            // Shipped labels and palettes contain no user or administrator configuration.
            static object Web(TagColors c) => new { background = c.Background, border = c.Border, color = c.Text };
            var groups = TagStyleKeys.Groups.ToDictionary(
                g => g,
                g => TagStyleCatalog.Labels(g).Select(l => new { key = l.Key, name = l.Name }).ToList(),
                StringComparer.Ordinal);
            // Custom labels are the administrator's (the editor reads them from the rules table):
            // every custom chip takes the "custom:*" palette colours.
            var palettes = TagStyleKeys.Presets.ToDictionary(
                p => p,
                p => TagStyleKeys.Groups
                    .SelectMany(g => TagStyleCatalog.Labels(g).Select(l => (Key: g + ":" + l.Key, Colors: TagStylePalettes.Concrete(p, g, l.Key))))
                    .Append((Key: TagStyleKeys.Custom + ":" + TagStyleKeys.AnyLabel, Colors: TagStylePalettes.Concrete(p, TagStyleKeys.Custom, TagStyleKeys.AnyLabel)))
                    .ToDictionary(e => e.Key, e => Web(e.Colors), StringComparer.Ordinal),
                StringComparer.Ordinal);
            return new JsonResult(new
            {
                quality = TagStyleCatalog.Quality.Select(q => new { label = q.Label, background = q.Background, color = q.Text }),
                age = TagStyleCatalog.AgeGroups.Select(g => new { id = g.Id, background = g.Background, border = g.Border, color = g.Text, ratings = g.Ratings, sample = g.Sample }),
                presets = TagStyleKeys.Presets,
                groups,
                palettes,
                // The Poster preset's colours depend on each artwork: the editor's contrast badge shows the worst
                // case its normalisation band allows, and its preview the example artwork's colours (palettes.poster).
                poster = new { worstContrast = Math.Round(PosterColour.WorstCaseContrast, 2), example = Web(PosterColour.Example) },
                // The glyph each genre label's tile shows (Other: the default one).
                genreIcons = TagStyleCatalog.Labels(TagStyleKeys.Genre).ToDictionary(l => l.Key, l => TagStyleCatalog.GenreIcon(l.Key), StringComparer.Ordinal),
            });
        }

        /// <summary>
        /// Admin-triggered full tag cache rebuild (config page button). Unlike the
        /// "Refresh Tag Cache" scheduled task, which only rebuilds items Jellyfin
        /// has re-saved since the last run, this always recomputes every item —
        /// the only way to pick up a tag-computation change (e.g. a plugin update)
        /// for items nobody has actually edited. Runs in the background; the
        /// existing cache keeps serving requests until the new one is ready and
        /// the on-disk file is atomically replaced.
        /// </summary>
        [HttpPost("tag-cache/rebuild")]
        [Authorize]
        public IActionResult RebuildTagCache()
        {
            if (!IsAdminUser()) return Forbid();

            if (JellyfinEnhanced.Instance?.Configuration?.TagCacheServerMode != true)
            {
                return BadRequest(new { success = false, message = "Server-Side Tag Cache is disabled." });
            }

            if (!_tagCacheService.TryStartManualFullRebuild())
            {
                return Conflict(new { success = false, message = "A tag cache rebuild is already in progress." });
            }

            return Ok(new { success = true, message = "Tag cache rebuild started in the background." });
        }

        /// <summary>
        /// Server tag cache state for the Media Tags admin page's Overview: whether
        /// the cache is on, how many items it holds, when it last changed (Unix ms,
        /// 0 = never) and whether a full build is running. Admin only.
        /// </summary>
        [HttpGet("tag-cache/summary")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetTagCacheSummary()
        {
            if (!IsAdminUser()) return Forbid();

            var enabled = JellyfinEnhanced.Instance?.Configuration?.TagCacheServerMode == true;
            return Ok(new
            {
                enabled,
                entries = enabled ? _tagCacheService.Count : 0,
                lastModified = enabled ? _tagCacheService.LastModified : 0,
                rebuilding = enabled && _tagCacheService.IsRebuilding,
            });
        }

        /// <summary>
        /// The Leaving soon source state for the Media Tags tab (counts, times, last failure). Never the URL,
        /// key or names. Admin only.
        /// </summary>
        /// <param name="leavingSoon">The Leaving soon service.</param>
        /// <returns>The status.</returns>
        [HttpGet("admin/leaving-soon")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetLeavingSoonStatus([FromServices] Services.LeavingSoonService leavingSoon)
        {
            if (!IsAdminUser()) return Forbid();
            return Ok(leavingSoon.Status(JellyfinEnhanced.Instance?.Configuration));
        }

        /// <summary>Refresh the Leaving soon facts now (the Media Tags tab's Refresh), then answer the status. Admin only.</summary>
        /// <param name="leavingSoon">The Leaving soon service.</param>
        /// <param name="cancellationToken">The request's cancellation.</param>
        /// <returns>The status after the refresh.</returns>
        [HttpPost("admin/leaving-soon/refresh")]
        [Authorize]
        [Produces("application/json")]
        public async Task<IActionResult> RefreshLeavingSoon([FromServices] Services.LeavingSoonService leavingSoon, CancellationToken cancellationToken)
        {
            if (!IsAdminUser()) return Forbid();
            await _tagCacheService.RefreshLeavingAsync(force: true, cancellationToken).ConfigureAwait(false);
            return Ok(leavingSoon.Status(JellyfinEnhanced.Instance?.Configuration));
        }

        /// <summary>
        /// The server-wide Media Tags settings as a portable document (<see cref="MediaTagsPortable.ExportAdmin"/>):
        /// every field the Media Tags tab writes except signals and secrets (API keys and the custom rule key are
        /// never part of it). Admin only.
        /// </summary>
        /// <returns>The document.</returns>
        [HttpGet("admin/media-tags/export")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Produces("application/json")]
        public IActionResult ExportAdminMediaTags()
        {
            if (!IsAdminUser()) return Forbid();
            var plugin = JellyfinEnhanced.Instance;
            if (plugin == null) return StatusCode(503);
            return Ok(MediaTagsPortable.ExportAdmin(plugin.Configuration, MediaTagsPageFields.Allowed));
        }

        /// <summary>
        /// What importing a server-wide Media Tags document would change: each field read and checked as the field
        /// patch reads it; unknown, secret and invalid fields are reported and skipped. Nothing is written: the page
        /// applies the changes through <c>POST admin/configuration</c> with the values it read as expected. Admin only.
        /// </summary>
        /// <param name="document">The document.</param>
        /// <returns>200 <c>{kind, v, imported, changes, skipped}</c>; 400 <c>{error}</c> for a document refused as a whole.</returns>
        [HttpPost("admin/media-tags/preview")]
        [Authorize]
        [RequestSizeLimit(PluginConfigurationPatch.MaxRequestBytes)]
        [Produces("application/json")]
        public IActionResult PreviewAdminMediaTags([FromBody] JsonElement document)
        {
            if (!IsAdminUser()) return Forbid();
            var plugin = JellyfinEnhanced.Instance;
            if (plugin == null) return StatusCode(503);
            var preview = MediaTagsPortable.PreviewAdmin(document, plugin.Configuration, MediaTagsPageFields.Allowed);
            return preview.Error != null ? BadRequest(new { error = preview.Error }) : Ok(PreviewBody(preview));
        }
    }
}
